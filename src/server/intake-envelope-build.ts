/** One explicit legacy decode followed by bounded accepted build checkpoints. */
import {
  assertClinicalOperation,
  currentClinicalOperation,
  runExclusiveClinicalOperation,
} from './clinical-operation.ts';
import { reportSnapshotInlineTextFits } from './intake-report-snapshot-catalog.ts';
import { createHash, randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import type { Database } from './database.ts';
import { readIntakeEnvelopeMaterialized, type IntakeEnvelopeSource } from './intake-authority.ts';
import {
  collectionCellReader,
  hasIntakeCollectionEnvelope,
  iterateSchemaEnvelopeText,
  iterateSchemaCellText,
  selectedEnvelopeStore,
} from './intake-collection-envelope.ts';
import {
  ENVELOPE_SCHEMA,
  lexicalEntries,
  schemaKey,
  schemaOrdinal,
  structuredKind,
  valueEnd,
  type SchemaControl,
  type SchemaTarget,
} from './intake-envelope-schema.ts';
import type { IntakeCollectionChange } from './intake-state-storage.ts';
import {
  prepareEnvelopeBuildResume,
  type EnvelopeBuildResume,
} from './intake-envelope-build-resume.ts';
import { recordIntakeWork, withIntakeWork } from './intake-work-accounting.ts';
import { prepareIntakeFilenameFactsSteps } from './intake-filename-facts.ts';
import { ensureIntakeFrontierObserver } from './intake-lookup-frontier-observer.ts';
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
export async function buildIntakeCollectionEnvelope(
  ...input: Parameters<typeof buildIntakeCollectionEnvelopeOwned>
): Promise<Awaited<ReturnType<typeof buildIntakeCollectionEnvelopeOwned>> | undefined> {
  const [db, source, options = {}] = input;
  return runExclusiveClinicalOperation(
    db,
    async (operation) => {
      ensureIntakeFrontierObserver(db);
      // A previous queued caller may have completed this exact current source.
      // The authenticated predicate still validates selected authority and schema.
      if (hasIntakeCollectionEnvelope(db, source)) {
        const { prepareIntakeFilenameSummary } = await import('./intake-summary-name.ts');
        await prepareIntakeFilenameSummary(db, source, {
          assertRunning() {
            assertClinicalOperation(db, operation);
            options.assertRunning?.();
          },
          assertPublicationCurrent: options.assertPublicationCurrent,
        });
        return undefined;
      }
      const result = await buildIntakeCollectionEnvelopeOwned(db, source, {
        ...options,
        assertRunning() {
          assertClinicalOperation(db, operation);
          options.assertRunning?.();
        },
      });
      const { prepareIntakeFilenameSummary } = await import('./intake-summary-name.ts');
      await prepareIntakeFilenameSummary(db, source, {
        assertRunning() {
          assertClinicalOperation(db, operation);
          options.assertRunning?.();
        },
        assertPublicationCurrent: options.assertPublicationCurrent,
      });
      return result;
    },
    { operation: currentClinicalOperation(db), assertRunning: options.assertRunning },
  );
}
async function buildIntakeCollectionEnvelopeOwned(
  db: Database,
  source: IntakeEnvelopeSource,
  options: {
    assertRunning?: () => void;
    assertPublicationCurrent?: () => void;
    onCheckpoint?: () => void | Promise<void>;
  } = {},
) {
  const legacy = readIntakeEnvelopeMaterialized(db, source),
    { collections, binding } = selectedEnvelopeStore(db, source);
  const version = (legacy.value.intake as { version: number }).version;
  const sourceTextHash = digest(legacy.text);
  withIntakeWork(db, 'warm', () =>
    recordIntakeWork('schemaBuildSourceHashBytes', Buffer.byteLength(legacy.text)),
  );
  if (binding.logicalHead === undefined) {
    const id = randomUUID();
    collections.commitMaintenance(
      collections.prepareLegacyBridge({
        operationId: id,
        requestDigest: digest(id),
        domainVersion: version,
      }),
    );
  }
  const resume = prepareEnvelopeBuildResume(
    db,
    source,
    {
      mode: legacy.mode,
      version,
      hash: sourceTextHash,
      bytes: Buffer.byteLength(legacy.text),
    },
    options,
  );
  try {
    const build = resume.build;
    const { put, cell, flush, record } = createEnvelopeBuildWriter(
      db,
      source,
      build,
      version,
      { ...options, assertRunning: resume.assertCurrent },
      resume,
    );
    void put;
    const text = legacy.text;
    let start = 0;
    while (/\s/.test(text[start] ?? '') && start < text.length) start++;
    const end = valueEnd(text, start),
      root = schemaKey('envelope', build);
    await cell('$before', text.slice(0, start));
    await record(text, start, end, 'root', root);
    await cell('$after', text.slice(end));
    await flush();
    resume.finish();
    const control: SchemaControl = {
      format: ENVELOPE_SCHEMA,
      mode: legacy.mode,
      root,
    };
    const { store } = collectionCellReader(db, source, 'builds', build);
    const expected = sourceTextHash,
      hash = createHash('sha256');
    let bytes = 0;
    for (const chunk of iterateSchemaEnvelopeText(store, control)) {
      resume.assertCurrent();
      hash.update(chunk);
      bytes += Buffer.byteLength(chunk);
      resume.countWork('validationHashBytes', Buffer.byteLength(chunk));
      resume.countWork('validationChunks');
      if (resume.work.validationChunks % 64 === 0) {
        resume.countWork('validationYields');
        await setImmediate();
        resume.assertCurrent();
      }
    }
    if (hash.digest('hex') !== expected || bytes !== Buffer.byteLength(text))
      throw Error('Schema build does not reproduce exact retained envelope');
    // The owner independently verifies the candidate graph/export before granting
    // the representation-only maintenance capability.
    const id = randomUUID();
    const prepared = collections.prepare(collections.openView(), {
      operationId: id,
      requestDigest: digest(id),
      domainVersion: version,
      changes: [
        {
          area: 'logical',
          collection: 'envelope.data',
          op: 'adoptCollection',
          fromArea: 'builds',
          fromCollection: build,
        },
        {
          area: 'logical',
          collection: 'envelope.control',
          op: 'put',
          key: 'representation',
          value: JSON.stringify(control),
        },
      ],
    });
    await collections.certifySchemaAdoptionAsync(prepared, {
      assertRunning: resume.assertCurrent,
    });
    resume.assertCurrent();
    const result = collections.commitMaintenance(prepared, { assertCurrent: resume.assertWitness });
    return {
      result,
      control,
      build,
      sourceTextHash: expected,
      sourceTextBytes: bytes,
      work: { ...resume.work },
    };
  } finally {
    resume.close();
  }
}

export function createEnvelopeBuildWriter(
  db: Database,
  source: IntakeEnvelopeSource,
  build: string,
  version: number,
  options: {
    assertRunning?: () => void;
    onCheckpoint?: () => void | Promise<void>;
  } = {},
  resume?: EnvelopeBuildResume,
) {
  const { collections } = selectedEnvelopeStore(db, source);
  const changes: IntakeCollectionChange[] = [];
  const flush = async () => {
    if (!changes.length) return;
    options.assertRunning?.();
    const id = randomUUID();
    const progress = resume?.progress();
    const batch = changes.splice(0);
    if (progress) batch.push(progress);
    const prepared = collections.prepare(collections.openView(), {
      operationId: id,
      requestDigest: digest(id),
      domainVersion: version,
      changes: batch,
    });
    resume?.assertCurrent();
    collections.commitMaintenance(prepared, resume ? { assertCurrent: resume.assertWitness } : {});
    if (progress) resume!.committed(progress);
    await options.onCheckpoint?.();
    await setImmediate();
  };
  const stage = async (change: IntakeCollectionChange) => {
    if (!resume || (await resume.emit(change))) changes.push(change);
    if (resume && changes.length >= 63) await flush();
  };
  const put = async (key: string, value: string) => {
    const change: IntakeCollectionChange = {
      area: 'builds',
      collection: build,
      op: 'put',
      key,
      value,
    };
    if (resume) await stage(change);
    else changes.push(change);
    if (!resume && changes.length >= 64) await flush();
  };
  const peek = (key: string): string | undefined => {
    if (resume) return resume.peek(key);
    const pending = [...changes]
      .reverse()
      .find((change) => change.collection === build && 'key' in change && change.key === key);
    if (pending?.op === 'put') return pending.value;
    if (pending?.op === 'delete') return undefined;
    const value = collections.get(collections.openView(), 'builds', build, key);
    if (value !== undefined && typeof value !== 'string')
      throw Error('Fragmented schema descriptor');
    return value;
  };
  const remove = async (key: string) => {
    const change: IntakeCollectionChange = { area: 'builds', collection: build, op: 'delete', key };
    if (resume) await stage(change);
    else changes.push(change);
    if (!resume && changes.length >= 64) await flush();
  };
  const cell = async (key: string, text: string) => {
    if (reportSnapshotInlineTextFits(text)) {
      await put(key, text);
      return;
    }
    await flush();
    const blob = resume?.blobName(key) ?? 'blob.' + randomUUID();
    for (let at = 0; at < text.length;) {
      let end = Math.min(at + 1024, text.length);
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
      const change: IntakeCollectionChange = {
        area: 'builds',
        collection: blob,
        op: 'appendBytes',
        bytes: Buffer.from(text.slice(at, end)),
      };
      if (resume) await stage(change);
      else changes.push(change);
      at = end;
      if (!resume && changes.length >= 64) await flush();
    }
    await flush();
    const change: IntakeCollectionChange = {
      area: 'builds',
      collection: build,
      op: 'putBytes',
      key,
      fromArea: 'builds',
      fromCollection: blob,
    };
    if (resume) await stage(change);
    else changes.push(change);
    await flush();
  };
  // The producer supplies bounded lexical pieces. Large values become checked
  // byte references without first creating a complete string or escaped copy.
  const cellPieces = async (key: string, pieces: Iterable<string>) => {
    let small = '',
      blob: string | undefined,
      high = '';
    const append = async (text: string) => {
      if (!text) return;
      if (!blob && reportSnapshotInlineTextFits(small + text)) {
        small += text;
        return;
      }
      if (!blob) {
        await flush();
        blob = resume?.blobName(key) ?? 'blob.' + randomUUID();
        // A supported inline buffer can exceed one byte leaf. Once promoted,
        // preserve the existing bounded UTF8 leaf format instead of appending it whole.
        for (let at = 0; at < small.length;) {
          let end = Math.min(at + 1024, small.length);
          if (end < small.length && /[\uD800-\uDBFF]/.test(small[end - 1]!)) end--;
          const change: IntakeCollectionChange = {
            area: 'builds',
            collection: blob,
            op: 'appendBytes',
            bytes: Buffer.from(small.slice(at, end)),
          };
          if (resume) await stage(change);
          else changes.push(change);
          at = end;
        }
        small = '';
      }
      const change: IntakeCollectionChange = {
        area: 'builds',
        collection: blob,
        op: 'appendBytes',
        bytes: Buffer.from(text),
      };
      if (resume) await stage(change);
      else changes.push(change);
      if (!resume && changes.length >= 64) await flush();
    };
    for (const piece of pieces) {
      options.assertRunning?.();
      for (let at = 0; at < piece.length; at += 1024) {
        let text = high + piece.slice(at, at + 1024);
        high = '';
        if (/[\uD800-\uDBFF]$/.test(text)) {
          high = text.slice(-1);
          text = text.slice(0, -1);
        }
        await append(text);
      }
    }
    await append(high);
    if (!blob) {
      await put(key, small);
      return;
    }
    await flush();
    const change: IntakeCollectionChange = {
      area: 'builds',
      collection: build,
      op: 'putBytes',
      key,
      fromArea: 'builds',
      fromCollection: blob,
    };
    if (resume) await stage(change);
    else changes.push(change);
    await flush();
  };
  const filenameFacts = async (id: string) => {
    await flush();
    options.assertRunning?.();
    const { store } = collectionCellReader(db, source, 'builds', build);
    const value = store.get('c:' + id);
    if (!value) throw Error('The selected filename is missing');
    if (typeof value === 'string' || value.bytes <= 16384) {
      if (peek('q:' + id) !== undefined) await remove('q:' + id);
      return;
    }
    const first = iterateSchemaCellText(store, 'c:' + id);
    try {
      if (!first.next().value?.trimStart().startsWith('"')) {
        if (peek('q:' + id) !== undefined) await remove('q:' + id);
        return;
      }
    } finally {
      first.return(undefined);
    }
    const binding = store.byteBinding!(value);
    const steps = prepareIntakeFilenameFactsSteps(iterateSchemaCellText(store, 'c:' + id), binding);
    try {
      for (;;) {
        options.assertRunning?.();
        const next = steps.next();
        options.assertRunning?.();
        if (next.done) {
          const current = store.get('c:' + id);
          if (!current || typeof current === 'string' || store.byteBinding!(current) !== binding)
            throw Error('The selected filename changed during preparation');
          await put('q:' + id, JSON.stringify(next.value));
          return;
        }
        await setImmediate();
        options.assertRunning?.();
      }
    } finally {
      steps.return(undefined as never);
    }
  };
  async function record(
    text: string,
    start: number,
    end: number,
    kind: string,
    id: string,
    parent?: string,
  ): Promise<void> {
    options.assertRunning?.();
    const token = text[start],
      shape = token === '{' ? 'object' : token === '[' ? 'array' : 'scalar';
    let count = 0,
      unique = 0,
      publicId: string | undefined;
    if (shape === 'scalar') {
      await cell('c:' + id, text.slice(start, end));
      await put('r:' + id, JSON.stringify({ kind, shape, count: 0 }));
      return;
    }
    let suffix = start;
    for (const entry of lexicalEntries(text, start, end)) {
      const occurrence = schemaKey(id, count),
        prefix = schemaKey(occurrence, 'prefix');
      let target: SchemaTarget;
      if (shape === 'array') {
        await put('p:' + occurrence, JSON.stringify({ parent: id, ordinal: count, field: null }));
        const itemKind = text[entry.start] === '{' ? kind : 'scalar';
        await record(text, entry.start, entry.end, itemKind, occurrence, parent);
        target = { type: 'record', id: occurrence };
        if (itemKind === 'scalar') {
          const value = JSON.parse(text.slice(entry.start, entry.end));
          if (value === null || ['string', 'number', 'boolean'].includes(typeof value))
            await put('m:' + id + ':' + schemaKey(value), occurrence);
        }
      } else {
        const nested = structuredKind(kind, entry.name!, text[entry.start]!);
        if (nested) {
          await put(
            'p:' + occurrence,
            JSON.stringify({
              parent: id,
              ordinal: count,
              field: schemaKey(entry.name!),
            }),
          );
          await record(text, entry.start, entry.end, nested, occurrence, id);
          target = { type: 'record', id: occurrence };
        } else {
          await cell('c:' + occurrence, text.slice(entry.start, entry.end));
          if (
            kind === 'intake' &&
            entry.name !== undefined &&
            ['originalName', 'locator'].includes(entry.name)
          )
            await filenameFacts(occurrence);
          target = { type: 'cell', id: occurrence };
        }
        const field = schemaKey(entry.name!);
        if (peek('f:' + id + ':' + field) === undefined) {
          unique++;
          await put('b:' + id + ':' + field, String(count));
        }
        await put('d:' + id + ':' + schemaOrdinal(count), peek('l:' + id + ':' + field) ?? 'null');
        await put('f:' + id + ':' + field, JSON.stringify(target));
        await put('l:' + id + ':' + field, String(count));
        await cell('n:' + occurrence, JSON.stringify(entry.name));
        if (entry.name === 'id' && parent && text[entry.start] === '"') {
          publicId = JSON.parse(text.slice(entry.start, entry.end)) as string;
        } else if (entry.name === 'id') publicId = undefined;
      }
      await cell('c:' + prefix, text.slice(entry.prefixStart, entry.start));
      await put(
        'o:' + id + ':' + schemaOrdinal(count),
        JSON.stringify({
          target,
          prefix,
          ...(entry.name === undefined ? {} : { name: occurrence }),
        }),
      );
      suffix = entry.end;
      count++;
    }
    await cell('s:' + id, text.slice(suffix, end));
    await put('r:' + id, JSON.stringify({ kind, shape, count }));
    await put('x:' + id, String(count));
    if (shape === 'object') await put('u:' + id, String(unique));
    if (publicId !== undefined && parent) {
      const key = 'i:' + parent + ':' + schemaKey(kind, publicId);
      if (peek(key) === undefined) await put(key, id);
      await put('j:' + parent + ':' + schemaKey(kind, publicId), id);
    }
  }
  return { put, cell, cellPieces, filenameFacts, flush, record, peek, remove };
}
