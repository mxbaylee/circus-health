/** Addressed domain changes fork one selected map; old records are shared. */
import { createHash, randomUUID } from 'node:crypto';
import type { IntakeCollectionChange } from './intake-state-storage.ts';
import type { IntakeCollectionHead } from './intake-state-evidence.ts';
import type { Database } from './database.ts';
import type { IntakeEnvelopeSource } from './intake-authority.ts';
import { hashIntakeJsonScalar } from './intake-json-scalar.ts';
import {
  selectedEnvelopeStore,
  collectionCellReader,
  createSchemaEnvelopeReader,
  projectIntakeEnvelopeMetadata,
  type IntakeCollectionEnvelopeReader,
  type IntakeEnvelopeRecord,
} from './intake-collection-envelope.ts';
import { createEnvelopeBuildWriter } from './intake-envelope-build.ts';
import {
  schemaKey,
  schemaOrdinal,
  structuredKind,
  parseSchemaControl,
  type SchemaTarget,
  type SchemaRecord,
  type SchemaOrder,
} from './intake-envelope-schema.ts';
export type IntakeEnvelopeMutation =
  | { op: 'set' | 'put'; record: IntakeEnvelopeRecord; field: string; jsonText: string }
  | { op: 'delete'; record: IntakeEnvelopeRecord; field: string }
  | { op: 'append'; record: IntakeEnvelopeRecord; field: string; jsonText: string }
  | {
      op: 'archive-current-import';
      record: IntakeEnvelopeRecord;
      acceptedProposalId: string | null;
      reviewToken: string | null;
    };
export interface IntakeEnvelopeDerivedPreparation {
  reader: IntakeCollectionEnvelopeReader;
  logical: IntakeCollectionHead['logical'];
  domainChanges: readonly IntakeCollectionChange[];
}
export async function prepareIntakeEnvelopeMutation(
  db: Database,
  source: IntakeEnvelopeSource,
  input: {
    reader: IntakeCollectionEnvelopeReader;
    changes:
      | Iterable<IntakeEnvelopeMutation>
      | ((
          staged: IntakeCollectionEnvelopeReader,
        ) => Iterable<IntakeEnvelopeMutation> | AsyncIterable<IntakeEnvelopeMutation>);
    additionalLogicalChanges?:
      | readonly IntakeCollectionChange[]
      | (() => readonly IntakeCollectionChange[] | Promise<readonly IntakeCollectionChange[]>);
    operationId: string;
    requestDigest: string;
    domainVersion: number;
    prepareDerived?: (
      input: IntakeEnvelopeDerivedPreparation,
    ) => Promise<readonly IntakeCollectionChange[]>;
    /** Acceptance derives this from exact updated workflow facts. A changed
     * state rebinds the derived roots once, without replaying domain mutations. */
    derivedIntakeState?: () => 'needs_review' | 'imported' | 'kept_original';
    assertRunning?: () => void;
    onCheckpoint?: () => void | Promise<void>;
  },
) {
  const { collections, source: expectedSource } = selectedEnvelopeStore(db, source),
    old = collections.binding(collections.openView());
  if (!old || JSON.stringify(input.reader.logical) !== JSON.stringify(old.logical))
    throw Error('Stale envelope mutation view');
  const replay = collections.replay(input.operationId, input.requestDigest);
  if (replay) return { replay, prepared: undefined };
  if (
    typeof input.additionalLogicalChanges !== 'function' &&
    input.additionalLogicalChanges?.some(
      (change) => change.area !== 'logical' || change.collection.startsWith('envelope.'),
    )
  )
    throw Error('Additional logical changes must belong to their domain');
  if (
    (typeof input.additionalLogicalChanges === 'function'
      ? 0
      : (input.additionalLogicalChanges?.length ?? 0)) +
      1 >
    64
  )
    throw Error('Envelope command requires bounded addressed changes');
  const pin = JSON.stringify(old.logical),
    assertCurrent = () => {
      input.assertRunning?.();
      const current = collections.binding(collections.openView());
      if (!current || JSON.stringify(current.logical) !== pin)
        throw Error('Stale envelope mutation build');
      const selectedSource = selectedEnvelopeStore(db, source).source;
      if (
        selectedSource.sha256 !== expectedSource.sha256 ||
        selectedSource.details_json !== expectedSource.details_json
      )
        throw Error('Stale envelope mutation source');
    };
  const build = 'mutation.' + randomUUID(),
    start = randomUUID();
  collections.commitMaintenance(
    collections.prepare(collections.openView(), {
      operationId: start,
      requestDigest: createHash('sha256').update(start).digest('hex'),
      domainVersion: old.logical.domainVersion,
      changes: [
        {
          area: 'builds',
          collection: build,
          op: 'adoptCollection',
          fromArea: 'logical',
          fromCollection: 'envelope.data',
        },
      ],
    }),
  );
  const writer = createEnvelopeBuildWriter(db, source, build, old.logical.domainVersion, {
    assertRunning: assertCurrent,
    onCheckpoint: input.onCheckpoint,
  });
  const staged = createSchemaEnvelopeReader(
    collectionCellReader(db, source, 'builds', build).store,
    parseSchemaControl(
      collections.get(collections.openView(), 'logical', 'envelope.control', 'representation'),
    ),
    old.logical,
  );
  const address = (record: IntakeEnvelopeRecord) => {
    try {
      return input.reader.address(record);
    } catch {
      return staged.address(record);
    }
  };
  const read = (key: string) => {
    const value = writer.peek(key);
    if (value === undefined) throw Error('Missing bounded mutation descriptor');
    return value;
  };
  const count = (key: string) => {
    const value = Number(read(key));
    if (!Number.isSafeInteger(value) || value < 0) throw Error('Invalid mutation count');
    return value;
  };
  const header = (id: string) => JSON.parse(read('r:' + id)) as SchemaRecord;
  const set = async (
    record: IntakeEnvelopeRecord,
    field: string,
    jsonText: string,
    replace = false,
  ) => {
    if (field === 'id') throw Error('Public IDs are immutable');
    if (
      replace &&
      record.kind !== 'packageFailures' &&
      !(record.kind === 'unit' && field === 'coverage') &&
      !(record.kind === 'intake' && field === 'metadata')
    )
      throw Error('Put requires addressed dictionary');
    const text = jsonText.trim();
    JSON.parse(text);
    const id = address(record),
      key = 'f:' + id + ':' + schemaKey(field),
      existing = writer.peek(key),
      owner = header(id);
    if (owner.shape !== 'object') throw Error('Field mutation requires selected object');
    if (existing !== undefined && !replace) {
      const ref = JSON.parse(existing) as SchemaTarget;
      if (ref.type !== 'cell') throw Error('Use explicit put to replace a structured field');
      if (!structuredKind(record.kind, field, text[0]!)) {
        await writer.cell('c:' + ref.id, text);
        if (record.kind === 'intake' && field === 'originalName')
          await writer.filenameFacts(ref.id);
        return;
      }
      // A known field can start as null. Installing its first structured value
      // creates typed children instead of hiding the new receipt/history in a cell.
    }
    const ordinal =
        existing === undefined ? count('x:' + id) : count('l:' + id + ':' + schemaKey(field)),
      next = existing === undefined ? schemaKey(id, ordinal) : schemaKey(id, ordinal, randomUUID()),
      kind = structuredKind(record.kind, field, text[0]!),
      ref: SchemaTarget = { type: kind ? 'record' : 'cell', id: next };
    if (kind) {
      await writer.put(
        'p:' + next,
        JSON.stringify({ parent: id, ordinal, field: schemaKey(field) }),
      );
      await writer.record(text, 0, text.length, kind, next, id);
    } else {
      await writer.cell('c:' + next, text);
      if (record.kind === 'intake' && ['originalName', 'locator'].includes(field))
        await writer.filenameFacts(next);
    }
    if (existing !== undefined) {
      const key = 'o:' + id + ':' + schemaOrdinal(ordinal),
        order = JSON.parse(read(key)) as SchemaOrder;
      await writer.put(key, JSON.stringify({ ...order, target: ref }));
    } else {
      const prefix = schemaKey(next, 'prefix');
      await writer.cell('n:' + next, JSON.stringify(field));
      await writer.cell('c:' + prefix, (owner.count ? ',' : '{') + JSON.stringify(field) + ':');
      await writer.put(
        'o:' + id + ':' + schemaOrdinal(ordinal),
        JSON.stringify({ target: ref, prefix, name: next }),
      );
      await writer.put('d:' + id + ':' + schemaOrdinal(ordinal), 'null');
      await writer.put('l:' + id + ':' + schemaKey(field), String(ordinal));
      await writer.put('b:' + id + ':' + schemaKey(field), String(ordinal));
      await writer.put('r:' + id, JSON.stringify({ ...owner, count: owner.count + 1 }));
      await writer.put('x:' + id, String(ordinal + 1));
      await writer.put('u:' + id, String(count('u:' + id) + 1));
      await writer.cell('s:' + id, '}');
    }
    await writer.put(key, JSON.stringify(ref));
    await writer.flush();
  };
  const remove = async (record: IntakeEnvelopeRecord, field: string, archiveCurrent = false) => {
    const id = address(record),
      owner = header(id),
      key = schemaKey(field);
    if (
      owner.shape !== 'object' ||
      (record.kind !== 'packageFailures' &&
        !(record.kind === 'unit' && field === 'processingException') &&
        !(
          archiveCurrent &&
          field === 'imported' &&
          id === address(staged.child(staged.root(), 'intake')!)
        ))
    )
      throw Error('Delete requires addressed dictionary');
    if (writer.peek('f:' + id + ':' + key) === undefined) return;
    let ordinal: number | null = count('l:' + id + ':' + key),
      removed = 0;
    while (ordinal !== null) {
      assertCurrent();
      const previous = JSON.parse(read('d:' + id + ':' + schemaOrdinal(ordinal))) as number | null;
      if (
        previous !== null &&
        (!Number.isSafeInteger(previous) || previous < 0 || previous >= ordinal)
      )
        throw Error('Invalid prior property chain');
      await writer.remove('o:' + id + ':' + schemaOrdinal(ordinal));
      ordinal = previous;
      removed++;
    }
    await writer.remove('f:' + id + ':' + key);
    await writer.remove('l:' + id + ':' + key);
    await writer.remove('b:' + id + ':' + key);
    await writer.put('r:' + id, JSON.stringify({ ...owner, count: owner.count - removed }));
    await writer.put('u:' + id, String(count('u:' + id) - 1));
    await writer.flush();
    if (owner.count === removed) await writer.cell('s:' + id, '{}');
    else {
      const prefix = 'o:' + id + ':',
        first = collections.range(collections.openView(), 'builds', build, {
          after: prefix,
          items: 1,
          bytes: 32768,
        }).items[0];
      if (!first || !first.key.startsWith(prefix) || typeof first.value !== 'string')
        throw Error('Missing first retained property');
      const entry = JSON.parse(first.value) as SchemaOrder,
        value = collections.get(collections.openView(), 'builds', build, 'c:' + entry.prefix);
      let text = '';
      if (typeof value === 'string') text = value;
      else if (value) {
        let after: string | undefined;
        do {
          const page = collections.readBytes(value, { after, items: 16, bytes: 65536 });
          for (const chunk of page.chunks)
            text += new TextDecoder('utf-8', { fatal: true }).decode(chunk);
          if (page.complete) break;
          after = page.after!;
        } while (true);
      } else throw Error('Missing property prefix');
      await writer.cell('c:' + entry.prefix, text.replace(/^[\s{,]*/, '{'));
    }
    await writer.flush();
  };
  for await (const change of typeof input.changes === 'function'
    ? input.changes(staged)
    : input.changes) {
    assertCurrent();
    if (change.op === 'archive-current-import') {
      const intake = staged.child(staged.root(), 'intake');
      if (!intake || address(change.record) !== address(intake))
        throw Error('Import archive requires selected intake');
      const current = staged.child(intake, 'imported');
      if (!current) {
        const value = staged.field(intake, 'imported');
        if (value.kind === 'value' && value.value !== null)
          throw Error('Invalid current import receipt');
        continue;
      }
      const movedId = address(current),
        movedKind = header(movedId).kind;
      await set(current, 'acceptedProposalId', JSON.stringify(change.acceptedProposalId));
      await set(current, 'reviewToken', JSON.stringify(change.reviewToken));
      if (!staged.child(intake, 'importHistory')) await set(intake, 'importHistory', '[]');
      const history = staged.child(intake, 'importHistory');
      if (!history) throw Error('Missing import history');
      const historyId = address(history),
        meta = header(historyId);
      if (meta.shape !== 'array') throw Error('Invalid import history');
      await remove(intake, 'imported', true);
      const prefix = schemaKey(historyId, meta.count, 'archived-prefix');
      await writer.cell('c:' + prefix, meta.count ? ',' : '[');
      await writer.cell('s:' + historyId, ']');
      await writer.put(
        'o:' + historyId + ':' + schemaOrdinal(meta.count),
        JSON.stringify({ target: { type: 'record', id: movedId }, prefix }),
      );
      await writer.put(
        'p:' + movedId,
        JSON.stringify({ parent: historyId, ordinal: meta.count, field: null }),
      );
      await writer.put('r:' + historyId, JSON.stringify({ ...meta, count: meta.count + 1 }));
      await writer.put('x:' + historyId, String(meta.count + 1));
      await writer.flush();
      // The moved receipt keeps its record identity/kind and all descendant
      // authority. Only an unknown public id can require first/last relocation.
      const idField = staged.field(current, 'id');
      if (idField.kind !== 'missing') {
        const start = staged.fieldChunks(current, 'id')[Symbol.iterator]().next().value;
        if (typeof start === 'string' && start.trimStart().startsWith('"')) {
          const key = hashIntakeJsonScalar(staged.fieldChunks(current, 'id'), [movedKind]).hash,
            firstKey = 'i:' + address(intake) + ':' + key,
            lastKey = 'j:' + address(intake) + ':' + key;
          await writer.remove(firstKey);
          await writer.remove(lastKey);
          let after: string | undefined;
          do {
            const page = staged.children(intake, 'importHistory', {
              after,
              items: 32,
              bytes: 32768,
            });
            for (const receipt of page.records) {
              if (receipt.kind !== movedKind || !staged.has(receipt, 'id')) continue;
              const head = staged.fieldChunks(receipt, 'id')[Symbol.iterator]().next().value;
              if (typeof head !== 'string' || !head.trimStart().startsWith('"')) continue;
              if (hashIntakeJsonScalar(staged.fieldChunks(receipt, 'id'), [movedKind]).hash !== key)
                continue;
              if (writer.peek(firstKey) === undefined) await writer.put(firstKey, address(receipt));
              await writer.put(lastKey, address(receipt));
            }
            if (page.complete) break;
            if (!page.after || page.after === after)
              throw Error('Import history cursor did not advance');
            after = page.after;
          } while (true);
          await writer.flush();
        }
      }
      continue;
    }
    if (change.op === 'delete') {
      await remove(change.record, change.field);
      continue;
    }
    if (change.op === 'set' || change.op === 'put') {
      await set(change.record, change.field, change.jsonText, change.op === 'put');
      await writer.flush();
      continue;
    }
    const text = change.jsonText.trim(),
      value = JSON.parse(text),
      parent = address(change.record),
      field = 'f:' + parent + ':' + schemaKey(change.field);
    if (writer.peek(field) === undefined) await set(change.record, change.field, '[]');
    const ref = JSON.parse(read(field)) as SchemaTarget;
    if (ref.type !== 'record') throw Error('Append requires selected child sequence');
    const meta = header(ref.id);
    if (meta.shape !== 'array') throw Error('Append requires selected array');
    const id = schemaKey(ref.id, meta.count),
      prefix = schemaKey(id, 'prefix');
    await writer.put(
      'p:' + id,
      JSON.stringify({ parent: ref.id, ordinal: meta.count, field: null }),
    );
    await writer.record(
      text,
      0,
      text.length,
      value !== null && typeof value === 'object' && !Array.isArray(value) ? meta.kind : 'scalar',
      id,
      parent,
    );
    await writer.cell('c:' + prefix, meta.count ? ',' : '[');
    await writer.cell('s:' + ref.id, ']');
    await writer.put(
      'o:' + ref.id + ':' + schemaOrdinal(meta.count),
      JSON.stringify({ target: { type: 'record', id }, prefix }),
    );
    await writer.put('r:' + ref.id, JSON.stringify({ ...meta, count: meta.count + 1 }));
    await writer.put('x:' + ref.id, String(meta.count + 1));
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value))
      await writer.put('m:' + ref.id + ':' + schemaKey(value), id);
    await writer.flush();
  }
  const intake = input.reader.child(input.reader.root(), 'intake');
  if (!intake) throw Error('Missing selected intake');
  await set(intake, 'version', JSON.stringify(input.domainVersion));
  await writer.flush();
  assertCurrent();
  const additional =
    typeof input.additionalLogicalChanges === 'function'
      ? await input.additionalLogicalChanges()
      : (input.additionalLogicalChanges ?? []);
  if (
    additional.length + 1 > 64 ||
    additional.some(
      (change) => change.area !== 'logical' || change.collection.startsWith('envelope.'),
    )
  )
    throw Error('Invalid additional domain collection changes');
  const domainChanges: readonly IntakeCollectionChange[] = [
    {
      area: 'logical',
      collection: 'envelope.data',
      op: 'adoptCollection',
      fromArea: 'builds',
      fromCollection: build,
    },
    ...additional,
  ];
  const prepare = (changes: readonly IntakeCollectionChange[]) =>
    collections.prepare(collections.openView(), {
      operationId: input.operationId,
      requestDigest: input.requestDigest,
      domainVersion: input.domainVersion,
      changes,
    });
  let prepared = prepare(domainChanges);
  if (input.prepareDerived) {
    let logical = collections.inspectPrepared(prepared).logical;
    collections.disposePreparation(prepared);
    let derived = await input.prepareDerived({ reader: staged, logical, domainChanges });
    if (input.derivedIntakeState) {
      const next = input.derivedIntakeState(),
        current = staged.field(staged.resolve(address(intake)), 'state');
      if (next !== 'needs_review' && next !== 'imported' && next !== 'kept_original')
        throw Error('Invalid derived acceptance state');
      if (current.kind !== 'value' || current.value !== next) {
        await set(intake, 'state', JSON.stringify(next));
        await writer.flush();
        prepared = prepare(domainChanges);
        logical = collections.inspectPrepared(prepared).logical;
        collections.disposePreparation(prepared);
        derived = await input.prepareDerived({ reader: staged, logical, domainChanges });
        if (input.derivedIntakeState() !== next)
          throw Error('Acceptance state changed after state-only derived rebinding');
      }
    }
    assertCurrent();
    if (
      derived.some((change) => change.area !== 'builds') ||
      derived.length + domainChanges.length > 64
    )
      throw Error('Derived publication must contain bounded auxiliary changes');
    prepared = prepare([...domainChanges, ...derived]);
    if (JSON.stringify(collections.inspectPrepared(prepared).logical) !== JSON.stringify(logical)) {
      collections.disposePreparation(prepared);
      throw Error('Derived publication changed domain selection');
    }
  }
  return {
    prepared,
    replay: undefined,
    projectDetailsJson(options: { bytes: number }) {
      assertCurrent();
      return projectIntakeEnvelopeMetadata(staged, options);
    },
  };
}
