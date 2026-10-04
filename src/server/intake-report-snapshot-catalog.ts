/** Report-owned immutable snapshots in the existing selected intake collection tree. */
import { createHash, randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import type { Database } from './database.ts';
import type { IntakeEnvelopeSource } from './intake-authority.ts';
import { selectedEnvelopeStore } from './intake-collection-envelope.ts';
import type {
  IntakeByteValue,
  IntakeCollectionChange,
  IntakeCollectionValue,
} from './intake-state-storage.ts';
import { withIntakeWork, recordIntakeWork } from './intake-work-accounting.ts';
import { INTAKE_TREE_VALUE_BYTES } from './intake-state-tree.ts';
import {
  assertClinicalOperation,
  currentClinicalOperation,
  runExclusiveClinicalOperation,
} from './clinical-operation.ts';

/** Account for the storage wrapper as well as the unescaped text. */
export function reportSnapshotInlineTextFits(text: string) {
  return (
    Buffer.byteLength(text) <= INTAKE_TREE_VALUE_BYTES &&
    Buffer.byteLength(JSON.stringify({ kind: 'inline', text })) <= INTAKE_TREE_VALUE_BYTES
  );
}

export const REPORT_SNAPSHOT_CATALOG = 'report.snapshots';
export interface ReportSnapshotPage {
  after?: string;
  items: number;
  bytes: number;
}
export interface ReportSnapshotMapReader {
  preceding(key: string): { key: string; value: string | IntakeByteValue } | undefined;
  get(key: string): string | IntakeByteValue | undefined;
  reference(key: string): ReportSnapshotMapReader | undefined;
  range(page: ReportSnapshotPage): {
    items: Array<{ key: string; value: string | IntakeByteValue }>;
    complete: boolean;
    after: string | null;
    count: number;
    bytes: number;
  };
  chunks(key: string): Iterable<string>;
  assertCurrent(): void;
}
export interface ReportSnapshotMapWriter extends ReportSnapshotMapReader {
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  /** Exact lexical text; bounded chunks are attached through the existing byte codec. */
  putText(key: string, pieces: Iterable<string> | AsyncIterable<string>): Promise<void>;
  attach(key: string, child: ReportSnapshotMapWriter): Promise<void>;
  putMany(entries: readonly { key: string; value: string }[]): Promise<void>;
}
export interface ReportSnapshotCatalog {
  open(snapshotId: string): ReportSnapshotMapReader | undefined;
  fork(snapshotId?: string): Promise<ReportSnapshotMapWriter>;
  forkReference(reader: ReportSnapshotMapReader): Promise<ReportSnapshotMapWriter>;
  publish(snapshotId: string, writer: ReportSnapshotMapWriter): Promise<void>;
  finalChanges(): Promise<IntakeCollectionChange[]>;
  assertCurrent(): void;
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const snapshotKey = (value: string) => {
  if (!/^[a-zA-Z0-9:._-]{1,200}$/.test(value)) throw Error('Invalid report snapshot identifier');
  return value;
};
/** Read-only construction does not publish a checkpoint. Writers remain auxiliary until finalChanges is staged. */
export function createReportSnapshotCatalog(
  db: Database,
  input: IntakeEnvelopeSource,
  options: {
    assertRunning?: () => void;
    onCheckpoint?: () => void | Promise<void>;
    /** Other domain owners can reuse the same authenticated snapshot codec. */
    catalog?:
      | 'report.snapshots'
      | 'plan.indexes'
      | 'review.snapshots'
      | 'ownership.snapshots'
      | 'duplicate.snapshots';
    /** Audit-only snapshots select with their ordinary clinical transaction. */
    catalogArea?: 'logical' | 'builds';
  } = {},
): ReportSnapshotCatalog {
  const initial = selectedEnvelopeStore(db, input),
    { source, collections } = initial;
  const head = collections.binding(collections.openView());
  if (!head) throw Error('Report snapshots require selected collection authority');
  const logical = JSON.stringify(head.logical),
    version = head.logical.domainVersion;
  const selectedCatalog = options.catalog ?? REPORT_SNAPSHOT_CATALOG;
  const selectedArea = options.catalogArea ?? 'logical',
    initialCatalog = JSON.stringify(
      collections.collection(collections.openView(), selectedArea, selectedCatalog) ?? null,
    );
  const catalog = 'report.catalog.' + randomUUID();
  let initialized = false;
  const names = new WeakMap<ReportSnapshotMapWriter, string>();
  const references = new WeakMap<ReportSnapshotMapReader, () => IntakeCollectionValue>();
  const assertCurrent = () => {
    const operation = currentClinicalOperation(db);
    if (operation) assertClinicalOperation(db, operation);
    options.assertRunning?.();
    const current = selectedEnvelopeStore(db, source);
    if (
      current.source.sha256 !== source.sha256 ||
      current.source.details_json !== source.details_json ||
      JSON.stringify(collections.binding(collections.openView())?.logical) !== logical ||
      JSON.stringify(
        collections.collection(collections.openView(), selectedArea, selectedCatalog) ?? null,
      ) !== initialCatalog
    )
      throw Error('Stale report snapshot source or logical state');
  };
  const checkpoint = async (changes: readonly IntakeCollectionChange[]) => {
    return runExclusiveClinicalOperation(
      db,
      async () => {
        assertCurrent();
        if (!changes.length) return;
        if (changes.length > 16) throw Error('Report checkpoint exceeds bounded change batch');
        withIntakeWork(db, 'warm', () =>
          recordIntakeWork('reportSnapshotCheckpointChanges', changes.length),
        );
        const id = randomUUID();
        collections.commitMaintenance(
          collections.prepare(collections.openView(), {
            operationId: id,
            requestDigest: hash(id),
            domainVersion: version,
            changes,
          }),
        );
        await options.onCheckpoint?.();
        await setImmediate();
        assertCurrent();
      },
      { operation: currentClinicalOperation(db) },
    );
  };
  const init = async () => {
    if (initialized) return;
    if (collections.collection(collections.openView(), selectedArea, selectedCatalog))
      await checkpoint([
        {
          area: 'builds',
          collection: catalog,
          op: 'adoptCollection',
          fromArea: selectedArea,
          fromCollection: selectedCatalog,
        },
      ]);
    else
      await checkpoint([
        {
          area: 'builds',
          collection: catalog,
          op: 'put',
          key: '$format',
          value: 'health-intake-report-snapshot-catalog-v1',
        },
      ]);
    initialized = true;
  };
  function reader(resolve: () => IntakeCollectionValue): ReportSnapshotMapReader {
    const result: ReportSnapshotMapReader = {
      preceding(key) {
        assertCurrent();
        return collections.precedingReferenced(resolve(), key);
      },
      assertCurrent,
      get(key) {
        assertCurrent();
        return collections.getReferenced(resolve(), key);
      },
      reference(key) {
        assertCurrent();
        if (!collections.referenceFrom(resolve(), key)) return undefined;
        return reader(() => {
          assertCurrent();
          const found = collections.referenceFrom(resolve(), key);
          if (!found) throw Error('Missing report snapshot child');
          return found;
        });
      },
      range(page) {
        assertCurrent();
        return collections.rangeReferenced(resolve(), page);
      },
      chunks(key) {
        return chunks(() => result.get(key));
      },
    };
    references.set(result, resolve);
    return result;
  }
  function* chunks(get: () => string | IntakeByteValue | undefined): Generator<string> {
    assertCurrent();
    const value = get();
    if (value === undefined) throw Error('Missing report snapshot text');
    if (typeof value === 'string') {
      for (let at = 0; at < value.length;) {
        let end = Math.min(at + 1024, value.length);
        if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1]!)) end--;
        yield value.slice(at, end);
        at = end;
      }
      return;
    }
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let after: string | undefined;
    do {
      assertCurrent();
      const page = collections.readBytes(value, { after, items: 16, bytes: 65536 });
      for (const chunk of page.chunks) {
        const text = decoder.decode(chunk, { stream: true });
        if (text) yield text;
      }
      if (page.complete) break;
      if (!page.after || page.after === after) throw Error('Report snapshot text did not advance');
      after = page.after;
    } while (true);
    const tail = decoder.decode();
    if (tail) yield tail;
    assertCurrent();
  }
  async function writer(from?: () => IntakeCollectionValue): Promise<ReportSnapshotMapWriter> {
    assertCurrent();
    const name = 'report.snapshot.' + randomUUID();
    await checkpoint(
      from
        ? [{ area: 'builds', collection: name, op: 'adoptReferenced', value: from() }]
        : [
            {
              area: 'builds',
              collection: name,
              op: 'put',
              key: '$format',
              value: 'health-intake-report-snapshot-map-v1',
            },
          ],
    );
    const result: ReportSnapshotMapWriter = {
      preceding(key) {
        assertCurrent();
        return collections.preceding(collections.openView(), 'builds', name, key);
      },
      assertCurrent,
      get(key) {
        assertCurrent();
        return collections.get(collections.openView(), 'builds', name, key);
      },
      reference(key) {
        assertCurrent();
        if (!collections.getCollectionReference(collections.openView(), 'builds', name, key))
          return undefined;
        return reader(() => {
          assertCurrent();
          const found = collections.getCollectionReference(
            collections.openView(),
            'builds',
            name,
            key,
          );
          if (!found) throw Error('Missing staged snapshot child');
          return found;
        });
      },
      range(page) {
        assertCurrent();
        return collections.range(collections.openView(), 'builds', name, page);
      },
      chunks(key) {
        return chunks(() => result.get(key));
      },
      async put(key, value) {
        await checkpoint([{ area: 'builds', collection: name, op: 'put', key, value }]);
      },
      async delete(key) {
        await checkpoint([{ area: 'builds', collection: name, op: 'delete', key }]);
      },
      async putMany(entries) {
        if (entries.length > 16) throw Error('Report checkpoint exceeds bounded change batch');
        await checkpoint(
          entries.map(({ key, value }) => ({
            area: 'builds',
            collection: name,
            op: 'put',
            key,
            value,
          })),
        );
      },
      async attach(key, child) {
        const childName = names.get(child);
        if (!childName) throw Error('Foreign report snapshot writer');
        await checkpoint([
          {
            area: 'builds',
            collection: name,
            op: 'putCollection',
            key,
            fromArea: 'builds',
            fromCollection: childName,
          },
        ]);
      },
      async putText(key, pieces) {
        const blob = 'report.text.' + randomUUID();
        let pending: IntakeCollectionChange[] = [],
          any = false,
          wroteBlob = false,
          carry = '',
          piecesSinceCheck = 0;
        const flush = async () => {
          if (pending.length) {
            await checkpoint(pending);
            wroteBlob = true;
            pending = [];
          }
        };
        for await (const piece of pieces) {
          if (++piecesSinceCheck === 64) {
            assertCurrent();
            await setImmediate();
            assertCurrent();
            piecesSinceCheck = 0;
          }
          if (typeof piece !== 'string') throw Error('Invalid report text chunk');
          // JSON producers can yield punctuation-sized pieces. Coalesce them
          // into bounded byte leaves so traversal scales with text bytes rather
          // than the producer's token count. A split surrogate stays in carry.
          for (let at = 0; at < piece.length;) {
            const take = Math.min(1024 - carry.length, piece.length - at);
            carry += piece.slice(at, at + take);
            at += take;
            if (carry.length === 1024) {
              const end = /[\uD800-\uDBFF]/.test(carry.at(-1)!) ? 1023 : 1024;
              pending.push({
                area: 'builds',
                collection: blob,
                op: 'appendBytes',
                bytes: Buffer.from(carry.slice(0, end)),
              });
              carry = carry.slice(end);
              any = true;
              if (pending.length === 16) await flush();
            }
          }
        }
        if (/[\uD800-\uDBFF]/.test(carry.at(-1) ?? ''))
          throw Error('Report text ended with an unpaired surrogate');
        if (carry) {
          pending.push({
            area: 'builds',
            collection: blob,
            op: 'appendBytes',
            bytes: Buffer.from(carry),
          });
          any = true;
        }
        // Tiny values need no separate byte collection or attachment checkpoint.
        // Reuse the already bounded UTF-8 leaves, preserving the streamed codec's
        // exact text semantics and keeping large values on its existing path.
        if (!wroteBlob) {
          const leaves = pending.map((change) => {
            if (change.op !== 'appendBytes') throw Error('Invalid pending snapshot text');
            return change.bytes;
          });
          const size = leaves.reduce((total, leaf) => total + leaf.byteLength, 0);
          if (size <= 16384) {
            const text = Buffer.concat(leaves).toString('utf8');
            if (reportSnapshotInlineTextFits(text)) {
              await result.put(key, text);
              return;
            }
          }
        }
        await flush();
        if (!any) {
          await result.put(key, '');
          return;
        }
        await checkpoint([
          {
            area: 'builds',
            collection: name,
            op: 'putBytes',
            key,
            fromArea: 'builds',
            fromCollection: blob,
          },
        ]);
      },
    };
    names.set(result, name);
    return result;
  }
  const open = (snapshotId: string): ReportSnapshotMapReader | undefined => {
    assertCurrent();
    const key = snapshotKey(snapshotId),
      area = initialized ? 'builds' : selectedArea,
      name = initialized ? catalog : selectedCatalog;
    if (!collections.getCollectionReference(collections.openView(), area, name, key))
      return undefined;
    return reader(() => {
      assertCurrent();
      const found = collections.getCollectionReference(collections.openView(), area, name, key);
      if (!found) throw Error('Missing selected report snapshot');
      return found;
    });
  };
  return {
    assertCurrent,
    open,
    async fork(snapshotId) {
      const prior = snapshotId === undefined ? undefined : open(snapshotId);
      if (snapshotId !== undefined && !prior) throw Error('Missing prior report snapshot');
      return writer(prior ? references.get(prior) : undefined);
    },
    async forkReference(prior) {
      const resolve = references.get(prior);
      if (!resolve) throw Error('Foreign report snapshot reader');
      return writer(resolve);
    },
    async publish(snapshotId, value) {
      const name = names.get(value);
      if (!name) throw Error('Foreign report snapshot writer');
      await init();
      const key = snapshotKey(snapshotId);
      if (collections.getCollectionReference(collections.openView(), 'builds', catalog, key))
        throw Error('Report snapshot identifier already exists');
      await checkpoint([
        {
          area: 'builds',
          collection: catalog,
          op: 'putCollection',
          key,
          fromArea: 'builds',
          fromCollection: name,
        },
      ]);
    },
    async finalChanges() {
      assertCurrent();
      if (!initialized) return [];
      return [
        {
          area: selectedArea,
          collection: selectedCatalog,
          op: 'adoptCollection',
          fromArea: 'builds',
          fromCollection: catalog,
        },
      ];
    },
  };
}
