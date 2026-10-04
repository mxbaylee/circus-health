/** Counted, representation-only upgrade of a selected older lexical field. */
import { createHash, randomUUID } from 'node:crypto';
import type { Database } from './database.ts';
import type { IntakeEnvelopeSource } from './intake-authority.ts';
import { createEnvelopeBuildWriter } from './intake-envelope-build.ts';
import {
  collectionCellReader,
  iterateSchemaCellText,
  openIntakeCollectionEnvelope,
  readSchemaOrder,
  readSchemaTextValue,
} from './intake-collection-envelope.ts';
import {
  schemaKey,
  schemaOrdinal,
  structuredKind,
  type SchemaTarget,
} from './intake-envelope-schema.ts';
import { prepareIntakeJsonLexical, type IntakeJsonLexicalSpan } from './intake-json-lexical.ts';
import { hashIntakeJsonScalar } from './intake-json-scalar.ts';
import { withIntakeWork, recordIntakeWork, recordIntakePeak } from './intake-work-accounting.ts';

type UpgradeOptions = { assertRunning?: () => void; onCheckpoint?: () => void | Promise<void> };
export function prepareIntakeMetadataHistorySchema(
  db: Database,
  source: IntakeEnvelopeSource,
  options: UpgradeOptions = {},
) {
  return prepareStructuredArray(
    db,
    source,
    ['intake'],
    'metadataHistory',
    'metadataHistoryEntry',
    options,
  );
}
export function prepareIntakeWorkflowPeopleDraftsSchema(
  db: Database,
  source: IntakeEnvelopeSource,
  options: UpgradeOptions = {},
) {
  return prepareStructuredArray(
    db,
    source,
    ['intake', 'workflow'],
    'peopleDrafts',
    'peopleDraft',
    options,
  );
}
async function prepareStructuredArray(
  db: Database,
  source: IntakeEnvelopeSource,
  path: string[],
  fieldName: string,
  itemKind: string,
  options: UpgradeOptions,
) {
  const view = openIntakeCollectionEnvelope(db, source);
  let parentRecord = view.root();
  for (const field of path) {
    const child = view.child(parentRecord, field);
    if (!child) return { changed: false };
    parentRecord = child;
  }
  const selected = collectionCellReader(db, source),
    { store, collections, head } = selected,
    parent = view.address(parentRecord),
    field = schemaKey(fieldName),
    key = 'f:' + parent + ':' + field,
    raw = store.get(key);
  if (raw === undefined) return { changed: false };
  if (typeof raw !== 'string') throw Error('Invalid metadata history descriptor');
  const target = JSON.parse(raw) as SchemaTarget;
  if (target.type === 'record') {
    view.child(parentRecord, fieldName);
    return { changed: false };
  }
  if (target.type !== 'cell') throw Error('Invalid metadata history target');
  const assertCurrent = () => {
    options.assertRunning?.();
    store.check();
  };
  const lexical = await prepareIntakeJsonLexical(iterateSchemaCellText(store, 'c:' + target.id), {
    assertRunning: assertCurrent,
    onWork(work) {
      withIntakeWork(db, 'reconstruction', () => {
        recordIntakeWork('schemaUpgradeInputUnits', work.inputUnits);
        recordIntakeWork('schemaUpgradeScratchReadBytes', work.scratchReadBytes);
        recordIntakeWork('schemaUpgradeScratchWrittenBytes', work.scratchWrittenBytes);
        recordIntakeWork('schemaUpgradeNodes', work.nodes);
        recordIntakeWork('schemaUpgradeSqliteCalls', work.sqliteCalls);
        recordIntakePeak('schemaUpgradePeakBufferBytes', work.peakBufferBytes);
      });
    },
  });
  try {
    if (lexical.root.shape !== 'array') return { changed: false };
    const build = 'schema.upgrade.' + randomUUID();
    const commit = (changes: Parameters<typeof collections.prepare>[1]['changes']) => {
      assertCurrent();
      const operationId = randomUUID();
      return collections.prepare(collections.openView(), {
        operationId,
        requestDigest: createHash('sha256').update(operationId).digest('hex'),
        domainVersion: head.logical.domainVersion,
        changes,
      });
    };
    collections.commitMaintenance(
      commit([
        {
          area: 'builds',
          collection: build,
          op: 'adoptCollection',
          fromArea: 'logical',
          fromCollection: 'envelope.data',
        },
      ]),
    );
    const writer = createEnvelopeBuildWriter(db, source, build, head.logical.domainVersion, {
      ...options,
      assertRunning: assertCurrent,
    });
    const token = (span: IntakeJsonLexicalSpan) =>
      lexical.pieces(span.start, Math.min(span.start + 1, span.end)).next().value as string;
    async function record(
      span: IntakeJsonLexicalSpan,
      kind: string,
      id: string,
      semanticParent?: string,
    ): Promise<void> {
      assertCurrent();
      if (span.shape === 'scalar') {
        await writer.cellPieces('c:' + id, lexical.pieces(span.start, span.end));
        await writer.put('r:' + id, JSON.stringify({ kind, shape: span.shape, count: 0 }));
        return;
      }
      let count = 0,
        unique = 0,
        suffix = span.start,
        publicIdHash: string | undefined;
      for (const child of lexical.children(span)) {
        const occurrence = schemaKey(id, count),
          prefix = schemaKey(occurrence, 'prefix');
        let ref: SchemaTarget;
        if (span.shape === 'array') {
          await writer.put(
            'p:' + occurrence,
            JSON.stringify({ parent: id, ordinal: count, field: null }),
          );
          const itemKind = child.shape === 'object' ? kind : 'scalar';
          await record(child, itemKind, occurrence, semanticParent);
          ref = { type: 'record', id: occurrence };
          if (child.shape === 'scalar')
            await writer.put(
              'm:' + id + ':' + hashIntakeJsonScalar(lexical.pieces(child.start, child.end)).hash,
              occurrence,
            );
        } else {
          let name = '',
            oversized = false;
          const nameHash = hashIntakeJsonScalar(
            lexical.pieces(child.nameStart!, child.nameEnd!),
            [],
            (unit) => {
              if (name.length < 64) name += unit;
              else oversized = true;
            },
          ).hash;
          const nested = oversized ? undefined : structuredKind(kind, name, token(child));
          if (nested) {
            await writer.put(
              'p:' + occurrence,
              JSON.stringify({ parent: id, ordinal: count, field: nameHash }),
            );
            await record(child, nested, occurrence, id);
            ref = { type: 'record', id: occurrence };
          } else {
            await writer.cellPieces('c:' + occurrence, lexical.pieces(child.start, child.end));
            ref = { type: 'cell', id: occurrence };
          }
          if (writer.peek('f:' + id + ':' + nameHash) === undefined) {
            unique++;
            await writer.put('b:' + id + ':' + nameHash, String(count));
          }
          await writer.put(
            'd:' + id + ':' + schemaOrdinal(count),
            writer.peek('l:' + id + ':' + nameHash) ?? 'null',
          );
          await writer.put('f:' + id + ':' + nameHash, JSON.stringify(ref));
          await writer.put('l:' + id + ':' + nameHash, String(count));
          // n is an authenticated JSON string; escape spelling is immaterial to
          // name identity, and retaining its lexical spelling avoids a full key.
          await writer.cellPieces(
            'n:' + occurrence,
            lexical.pieces(child.nameStart!, child.nameEnd!),
          );
          if (!oversized && name === 'id')
            publicIdHash =
              semanticParent && token(child) === '"'
                ? hashIntakeJsonScalar(lexical.pieces(child.start, child.end), [kind]).hash
                : undefined;
        }
        await writer.cellPieces(
          'c:' + prefix,
          lexical.pieces(count === 0 ? span.start : child.prefix, child.start),
        );
        await writer.put(
          'o:' + id + ':' + schemaOrdinal(count),
          JSON.stringify({
            target: ref,
            prefix,
            ...(span.shape === 'object' ? { name: occurrence } : {}),
          }),
        );
        suffix = child.end;
        count++;
      }
      await writer.cellPieces('s:' + id, lexical.pieces(suffix, span.end));
      await writer.put('r:' + id, JSON.stringify({ kind, shape: span.shape, count }));
      await writer.put('x:' + id, String(count));
      if (span.shape === 'object') await writer.put('u:' + id, String(unique));
      if (semanticParent && publicIdHash) {
        const index = 'i:' + semanticParent + ':' + publicIdHash;
        if (writer.peek(index) === undefined) await writer.put(index, id);
        await writer.put('j:' + semanticParent + ':' + publicIdHash, id);
      }
    }
    const ordinal = Number(readSchemaTextValue(store, 'l:' + parent + ':' + field)),
      orderKey = 'o:' + parent + ':' + schemaOrdinal(ordinal),
      order = readSchemaOrder(readSchemaTextValue(store, orderKey));
    if (
      !Number.isSafeInteger(ordinal) ||
      ordinal < 0 ||
      order.target.type !== 'cell' ||
      order.target.id !== target.id
    )
      throw Error('Metadata history order disagrees');
    const id = schemaKey(build, fieldName),
      replacement = { type: 'record' as const, id };
    await writer.put('p:' + id, JSON.stringify({ parent, ordinal, field }));
    await record({ ...lexical.root, start: 0, end: lexical.work.inputUnits }, itemKind, id, parent);
    await writer.put(key, JSON.stringify(replacement));
    await writer.put(orderKey, JSON.stringify({ ...order, target: replacement }));
    await writer.flush();
    const prepared = commit([
      {
        area: 'logical',
        collection: 'envelope.data',
        op: 'adoptCollection',
        fromArea: 'builds',
        fromCollection: build,
      },
    ]);
    try {
      await collections.certifySchemaAdoptionAsync(prepared, { assertRunning: assertCurrent });
      collections.commitMaintenance(prepared);
    } finally {
      collections.disposePreparation(prepared);
    }
    return { changed: true };
  } finally {
    lexical.close();
  }
}
