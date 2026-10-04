/** Immutable duplicate audit evidence in the selected intake graph. The private
 * ordering index is disposable; exact IDs and values remain authenticated. */
import { createHash, randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { clinicalReviewRevision, type Database } from './database.ts';
import type { IntakeEnvelopeSource } from './intake-authority.ts';
import { selectedEnvelopeStore } from './intake-collection-envelope.ts';
import { canonicalLiteral } from './intake-format.ts';
import { disposableSqlite } from './disposable-sqlite.ts';
import {
  createReportSnapshotCatalog,
  type ReportSnapshotCatalog,
  type ReportSnapshotMapReader,
  type ReportSnapshotMapWriter,
} from './intake-report-snapshot-catalog.ts';
import {
  withIntakeWork,
  recordIntakeWork,
  type IntakeWorkPhase,
} from './intake-work-accounting.ts';
import type {
  RetainedDuplicateEvidenceReference,
  SavedDuplicateEvidenceValue,
} from '../shared/saved-duplicate-evidence.ts';

const FORMAT = 'health-duplicate-evidence-snapshot-v1';
const MAP_FORMAT = 'health-duplicate-evidence-snapshot-map-v1';
const ID = 'identity:',
  VALUE = 'value:',
  DIGEST = 'digest:';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
type Kind = 'observation' | 'medication' | 'procedure' | 'document';
function text(reader: ReportSnapshotMapReader, key: string) {
  return [...reader.chunks(key)].join('');
}
function* identities(reader: ReportSnapshotMapReader) {
  let after = ID;
  while (true) {
    const page = reader.range({ after, items: 64, bytes: 65536 });
    for (const entry of page.items) {
      if (!entry.key.startsWith(ID)) return;
      const digest = entry.key.slice(ID.length);
      if (!/^[a-f0-9]{64}$/.test(digest)) throw Error('Invalid retained evidence identity key');
      yield digest;
    }
    if (page.complete) return;
    if (!page.after || page.after === after) throw Error('Evidence identity page did not advance');
    after = page.after;
  }
}
function checked(catalog: ReportSnapshotCatalog, reference: RetainedDuplicateEvidenceReference) {
  if (
    reference.format !== FORMAT ||
    !Number.isSafeInteger(reference.count) ||
    reference.count < 0 ||
    !/^[a-f0-9]{64}$/.test(reference.digest)
  )
    throw Error('Invalid duplicate evidence snapshot reference');
  const reader = catalog.open(reference.snapshotId);
  if (
    !reader ||
    reader.get('$format') !== MAP_FORMAT ||
    text(reader, '$meta') !== JSON.stringify(reference) ||
    reader.range({ after: '\uffff', items: 1, bytes: 1 }).count !== reference.count * 3 + 3
  )
    throw Error('Duplicate evidence snapshot reference disagrees with retained authority');
  return reader;
}
function count(
  db: Database,
  phase: IntakeWorkPhase,
  name: Parameters<typeof recordIntakeWork>[0],
  amount = 1,
) {
  withIntakeWork(db, phase, () => recordIntakeWork(name, amount));
}

/** One factory composes all selected targets with this stable custodian. Its
 * final builds-only changes must join the owner's ordinary clinical commit. */
export function createDuplicateEvidenceSnapshotPreparation(
  db: Database,
  source: IntakeEnvelopeSource,
  options: { assertRunning?: () => void } = {},
) {
  const initial = selectedEnvelopeStore(db, source),
    { collections } = initial,
    basis = clinicalReviewRevision(db),
    version = collections.binding(collections.openView())!.logical.domainVersion,
    binding = { intakeId: initial.identity.intakeId, sourceHash: initial.identity.sourceHash },
    catalog = createReportSnapshotCatalog(db, source, {
      ...options,
      catalog: 'duplicate.snapshots',
      catalogArea: 'builds',
    });
  let finished = false,
    disposed = false;
  const assertCurrent = () => {
    if (disposed) throw Error('Disposed duplicate evidence preparation');
    options.assertRunning?.();
    catalog.assertCurrent();
    if (clinicalReviewRevision(db) !== basis)
      throw Error('Duplicate evidence changed during preparation');
  };
  const yieldStep = async (phase: IntakeWorkPhase) => {
    count(db, phase, 'duplicateSnapshotYields');
    await setImmediate();
    assertCurrent();
  };
  return {
    assertCurrent,
    async prepareTarget(input: {
      kind: Kind;
      recordId: string;
      previous?: RetainedDuplicateEvidenceReference;
      /** Internal caller supplies this only after proving an accepted kind
       * transition for the exact same retained identity and primary source. */
      previousKind?: Kind;
      evidence: () => Iterable<{ id: string; value: SavedDuplicateEvidenceValue }>;
    }): Promise<RetainedDuplicateEvidenceReference> {
      if (finished) throw Error('Duplicate evidence preparation already finished');
      assertCurrent();
      if (
        !['observation', 'medication', 'procedure', 'document'].includes(input.kind) ||
        (input.previousKind !== undefined &&
          (!input.previous ||
            !['observation', 'medication', 'procedure', 'document'].includes(
              input.previousKind,
            ))) ||
        !input.recordId
      )
        throw Error('Invalid duplicate evidence target');
      if (
        input.previous &&
        (input.previous.source.intakeId !== binding.intakeId ||
          input.previous.source.sourceHash !== binding.sourceHash)
      )
        throw Error('Duplicate evidence custodian changed');
      const previous = input.previous && checked(catalog, input.previous),
        target = JSON.stringify([input.kind, input.recordId]),
        previousTarget = JSON.stringify([input.previousKind ?? input.kind, input.recordId]),
        targetChanged = previousTarget !== target,
        phase: IntakeWorkPhase = previous ? 'warm' : 'reconstruction';
      if (previous && text(previous, '$target') !== previousTarget)
        throw Error('Duplicate evidence target changed');
      const scratch = disposableSqlite('duplicate-evidence-seen-');
      try {
        scratch.db.exec(
          'CREATE TABLE seen(hash TEXT PRIMARY KEY,id TEXT NOT NULL COLLATE BINARY UNIQUE)',
        );
        const insert = scratch.db.prepare('INSERT INTO seen VALUES(?,?)'),
          contains = scratch.db.prepare('SELECT 1 FROM seen WHERE hash=?');
        let writer: ReportSnapshotMapWriter | undefined,
          pending: Array<{ key: string; value: string }> = [],
          priorId: Buffer | undefined,
          total = 0,
          changed = 0,
          visited = 0;
        const output = createHash('sha256').update('[');
        count(db, phase, 'duplicateSnapshotHashedBytes', 1);
        const writable = async () =>
          (writer ??= previous ? await catalog.forkReference(previous) : await catalog.fork());
        const flush = async () => {
          if (pending.length) {
            await (await writable()).putMany(pending);
            pending = [];
          }
        };
        const put = async (key: string, value: string) => {
          if (Buffer.byteLength(value) > 4096) {
            await flush();
            await (await writable()).putText(key, [value]);
          } else {
            pending.push({ key, value });
            if (pending.length === 16) await flush();
          }
        };
        for (const row of input.evidence()) {
          if (typeof row.id !== 'string' || !row.id || Buffer.from(row.id).toString() !== row.id)
            throw Error('Invalid duplicate evidence row identity');
          const encodedId = Buffer.from(row.id);
          if (priorId && Buffer.compare(priorId, encodedId) >= 0)
            throw Error('Evidence IDs must be distinct in SQLite BINARY order');
          priorId = encodedId;
          const identity = hash(row.id),
            encoded = canonicalLiteral(row.value),
            digest = hash(encoded);
          insert.run(identity, row.id);
          count(
            db,
            phase,
            'duplicateSnapshotScratchWrittenBytes',
            encodedId.length + identity.length,
          );
          count(db, phase, 'duplicateSnapshotComparedRows');
          count(
            db,
            phase,
            'duplicateSnapshotHashedBytes',
            encodedId.length + Buffer.byteLength(encoded) * 2 + (total ? 1 : 0),
          );
          if (total++) output.update(',');
          output.update(encoded);
          const oldDigest = previous?.get(DIGEST + identity),
            oldId = previous?.get(ID + identity);
          if (
            (oldDigest === undefined) !== (oldId === undefined) ||
            (oldDigest !== undefined &&
              (typeof oldDigest !== 'string' ||
                !/^[a-f0-9]{64}$/.test(oldDigest) ||
                previous!.get(VALUE + identity) === undefined))
          )
            throw Error('Incomplete retained evidence row');
          if (oldId !== undefined && text(previous!, ID + identity) !== row.id)
            throw Error('Evidence identity hash collision');
          if (oldDigest !== digest) {
            changed++;
            count(db, phase, 'duplicateSnapshotChangedRows');
            if (oldDigest === undefined) await put(ID + identity, row.id);
            await put(VALUE + identity, encoded);
            await put(DIGEST + identity, digest);
          }
          if (++visited % 64 === 0) await yieldStep(phase);
        }
        if (previous)
          for (const identity of identities(previous)) {
            count(db, phase, 'duplicateSnapshotComparedRows');
            if (!contains.get(identity)) {
              await flush();
              const value = await writable();
              for (const prefix of [ID, VALUE, DIGEST]) await value.delete(prefix + identity);
              changed++;
              count(db, phase, 'duplicateSnapshotChangedRows');
            }
            if (++visited % 64 === 0) await yieldStep(phase);
          }
        count(db, phase, 'duplicateSnapshotHashedBytes', 1);
        const digest = output.update(']').digest('hex');
        if (previous && !changed) {
          if (total !== input.previous!.count || digest !== input.previous!.digest)
            throw Error('Unchanged evidence disagrees with retained digest');
          assertCurrent();
          if (!targetChanged) return structuredClone(input.previous!);
        }
        const reference: RetainedDuplicateEvidenceReference = {
          format: FORMAT,
          source: { ...binding },
          snapshotId: 'duplicate:' + randomUUID(),
          count: total,
          digest,
        };
        if (!previous) await put('$format', MAP_FORMAT);
        if (!previous || targetChanged) await put('$target', target);
        await put('$meta', JSON.stringify(reference));
        await flush();
        await catalog.publish(reference.snapshotId, await writable());
        assertCurrent();
        return reference;
      } finally {
        scratch.close();
      }
    },
    async finish() {
      if (finished) throw Error('Duplicate evidence preparation already finished');
      finished = true;
      assertCurrent();
      const changes = Object.freeze(
        (await catalog.finalChanges()).map((change) => Object.freeze(change)),
      );
      return {
        changes,
        assertCurrent,
        prepareStandalone() {
          assertCurrent();
          const operationId = randomUUID(),
            prepared = collections.prepare(collections.openView(), {
              operationId,
              requestDigest: hash(operationId),
              domainVersion: version,
              changes,
            });
          let released = false;
          return {
            assertCurrent,
            apply() {
              if (released) throw Error('Disposed duplicate evidence selection');
              assertCurrent();
              collections.stage(prepared);
            },
            dispose() {
              if (!released) {
                released = true;
                collections.disposePreparation(prepared);
              }
            },
          };
        },
        dispose() {
          disposed = true;
        },
      };
    },
    dispose() {
      disposed = true;
    },
  };
}

/** Historical export first orders scalar IDs in disposable SQLite. It never
 * rewrites accepted snapshots or loads the complete evidence values array. */
export async function prepareRetainedDuplicateEvidenceSnapshot(
  db: Database,
  reference: RetainedDuplicateEvidenceReference,
  options: { assertRunning?: () => void } = {},
) {
  const source = { id: reference.source.intakeId },
    selected = selectedEnvelopeStore(db, source);
  if (selected.identity.sourceHash !== reference.source.sourceHash)
    throw Error('Duplicate evidence snapshot source changed');
  const catalog = createReportSnapshotCatalog(db, source, {
      ...options,
      catalog: 'duplicate.snapshots',
      catalogArea: 'builds',
    }),
    reader = checked(catalog, reference),
    scratch = disposableSqlite('duplicate-evidence-order-');
  let closed = false;
  const assertCurrent = () => {
    if (closed) throw Error('Disposed duplicate evidence reader');
    catalog.assertCurrent();
  };
  try {
    scratch.db.exec(
      'CREATE TABLE ordered(id TEXT COLLATE BINARY PRIMARY KEY,hash TEXT NOT NULL UNIQUE)',
    );
    const insert = scratch.db.prepare('INSERT INTO ordered VALUES(?,?)');
    let total = 0;
    for (const identity of identities(reader)) {
      const id = text(reader, ID + identity);
      if (
        !id ||
        hash(id) !== identity ||
        !/^[a-f0-9]{64}$/.test(String(reader.get(DIGEST + identity)))
      )
        throw Error('Invalid retained evidence identity or digest');
      insert.run(id, identity);
      count(db, 'reconstruction', 'duplicateSnapshotSortedRows');
      count(
        db,
        'reconstruction',
        'duplicateSnapshotScratchWrittenBytes',
        Buffer.byteLength(id) + identity.length,
      );
      if (++total % 64 === 0) {
        count(db, 'reconstruction', 'duplicateSnapshotYields');
        await setImmediate();
        assertCurrent();
      }
    }
    if (total !== reference.count) throw Error('Retained evidence membership count disagrees');
    const result = {
      reference,
      target: JSON.parse(text(reader, '$target')) as [Kind, string],
      assertCurrent,
      *entries() {
        assertCurrent();
        for (const row of scratch.db
          .prepare('SELECT id,hash FROM ordered ORDER BY id COLLATE BINARY')
          .iterate()) {
          assertCurrent();
          const identity = String(row.hash),
            id = String(row.id);
          count(
            db,
            'reconstruction',
            'duplicateSnapshotScratchReadBytes',
            Buffer.byteLength(id) + identity.length,
          );
          yield { id, chunks: () => reader.chunks(VALUE + identity) };
        }
      },
      *chunks() {
        const output = createHash('sha256');
        const piece = (value: string) => {
          output.update(value);
          count(db, 'reconstruction', 'duplicateSnapshotHashedBytes', Buffer.byteLength(value));
          return value;
        };
        yield piece('[');
        let first = true;
        for (const entry of result.entries()) {
          if (!first) yield piece(',');
          first = false;
          for (const value of entry.chunks()) yield piece(value);
        }
        yield piece(']');
        if (output.digest('hex') !== reference.digest)
          throw Error('Complete retained evidence digest disagrees');
      },
      close() {
        if (!closed) {
          closed = true;
          scratch.close();
        }
      },
    };
    return result;
  } catch (error) {
    scratch.close();
    throw error;
  }
}
