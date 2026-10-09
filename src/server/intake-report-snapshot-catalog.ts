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
import { schemaOrdinal } from './intake-envelope-schema.ts';
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
export interface ReportSnapshotBytePage {
  data: Buffer;
  complete: boolean;
  after: string | null;
  skip: number;
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
  /** Bounded raw bytes; preserves UTF-8 splits and addresses the existing leaf ordinal. */
  bytePage(key: string, position: { after: string | null; skip: number }): ReportSnapshotBytePage;
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
  /** Stage only the reserved current-identity locator; public snapshot names stay immutable. */
  bindCurrentIdentityScope(groupId: string, alias: ReportSnapshotMapReader): Promise<void>;
  /** Optimization-only same-source bridge. Historical receipt snapshot lookups never fall back. */
  identityScopeReuseReader(
    snapshotId: string,
    area?: 'logical' | 'builds',
  ): { reader: ReportSnapshotMapReader; area: 'logical' | 'builds' } | undefined;
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
  const selectedCatalog = options.catalog ?? REPORT_SNAPSHOT_CATALOG;
  const selectedArea = options.catalogArea ?? 'logical';
  const initialState = collections.collectionState(
    selectedArea,
    selectedCatalog,
    selectedCatalog === REPORT_SNAPSHOT_CATALOG && selectedArea === 'logical',
  );
  if (!initialState.logical) throw Error('Report snapshots require selected collection authority');
  const logical = JSON.stringify(initialState.logical),
    version = initialState.logical.domainVersion,
    initialCatalog = JSON.stringify(initialState.collection ?? null),
    initialIdentityBuildCatalog = JSON.stringify(initialState.buildCollection ?? null);
  let borrowedIdentityBuild = false;
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
      current.source.details_json !== source.details_json
    )
      throw Error('Stale report snapshot source or logical state');
    const state = collections.collectionState(selectedArea, selectedCatalog, borrowedIdentityBuild);
    if (
      JSON.stringify(state.logical) !== logical ||
      JSON.stringify(state.collection ?? null) !== initialCatalog ||
      (borrowedIdentityBuild &&
        JSON.stringify(state.buildCollection ?? null) !== initialIdentityBuildCatalog)
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
      bytePage(key, position) {
        return bytePage(() => result.get(key), position);
      },
    };
    references.set(result, resolve);
    return result;
  }
  function bytePage(
    get: () => string | IntakeByteValue | undefined,
    position: { after: string | null; skip: number },
  ): ReportSnapshotBytePage {
    assertCurrent();
    if (
      (position.after !== null && !/^[0-9]{16}$/.test(position.after)) ||
      !Number.isSafeInteger(position.skip) ||
      position.skip < 0 ||
      position.skip >= 4096
    )
      throw Error('Invalid report byte page position');
    const value = get();
    if (value === undefined) throw Error('Missing report snapshot text');
    if (typeof value === 'string') {
      const bytes = Buffer.from(value);
      if (position.after !== null || position.skip > bytes.length)
        throw Error('Invalid inline report byte page position');
      const data = bytes.subarray(position.skip, position.skip + 32768);
      assertCurrent();
      return { data, complete: true, after: null, skip: 0 };
    }
    const first = position.after === null ? 0 : Number(position.after) + 1;
    if (!Number.isSafeInteger(first) || first < 0 || first >= value.chunks)
      throw Error('Invalid report byte page ordinal');
    const page = collections.readBytes(value, {
      after: position.after ?? undefined,
      items: 64,
      bytes: 32768 + 4096,
    });
    if (!page.chunks.length || position.skip >= page.chunks[0]!.length)
      throw Error('Invalid report byte page skip');
    const output: Buffer[] = [];
    let used = 0,
      ordinal = first,
      skip = position.skip;
    for (const chunk of page.chunks) {
      const take = Math.min(chunk.length - skip, 32768 - used);
      output.push(chunk.subarray(skip, skip + take));
      used += take;
      if (skip + take < chunk.length) {
        skip += take;
        break;
      }
      ordinal++;
      skip = 0;
      if (used === 32768) break;
    }
    const complete = ordinal === value.chunks && skip === 0;
    assertCurrent();
    return {
      data: Buffer.concat(output),
      complete,
      after: complete || ordinal === 0 ? null : schemaOrdinal(ordinal - 1),
      skip: complete ? 0 : skip,
    };
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
      const page = collections.readBytes(value, {
        after,
        items: 16,
        bytes: 65536,
      });
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
        ? [
            {
              area: 'builds',
              collection: name,
              op: 'adoptReferenced',
              value: from(),
            },
          ]
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
      bytePage(key, position) {
        return bytePage(() => result.get(key), position);
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
        assertCurrent();
        const prior = result.get(key),
          retained = prior && typeof prior !== 'string' ? prior : undefined,
          blob = 'report.text.' + randomUUID(),
          producerHash = createHash('sha256');
        let oldCount = retained?.chunks ?? 0,
          ordinal = 0,
          producedBytes = 0,
          carry = '',
          piecesSinceCheck = 0,
          chunksSinceCheck = 0,
          fragmented = false,
          prefix: Buffer[] = [],
          prefixBytes = 0,
          pending: IntakeCollectionChange[] = [];
        const record = (
          metric: keyof import('./intake-work-accounting.ts').IntakeHostWork,
          bytes = 1,
        ) => withIntakeWork(db, 'warm', () => recordIntakeWork(metric, bytes));
        // Only the existing owner's branded byte capability can seed this fork.
        // Public roots, names and self-described counts cannot select prior bytes.
        // Adopt before an asynchronous producer can evict the bounded capability.
        // An eventual inline replacement keeps this constant-cost unused fork.
        if (retained)
          await checkpoint([
            {
              area: 'builds',
              collection: blob,
              op: 'adoptBytesReferenced',
              value: retained,
            },
          ]);
        const flush = async () => {
          if (pending.length) await checkpoint(pending);
          pending = [];
        };
        const checkedBytes = (raw: unknown) => {
          if (typeof raw !== 'string' || raw.length > 5500)
            throw Error('Invalid retained report text leaf');
          const value = Buffer.from(raw, 'base64');
          if (!value.length || value.length > 4096 || value.toString('base64') !== raw)
            throw Error('Invalid retained report text leaf');
          return value;
        };
        const writeChunk = async (chunk: Buffer) => {
          assertCurrent();
          record('reportSnapshotTextComparedChunks');
          if (ordinal < oldCount) {
            const previous = checkedBytes(
              collections.get(collections.openView(), 'builds', blob, schemaOrdinal(ordinal)),
            );
            record('reportSnapshotTextReadBytes', previous.byteLength);
            if (!previous.equals(chunk)) {
              pending.push({
                area: 'builds',
                collection: blob,
                op: 'replaceBytes',
                index: ordinal,
                bytes: chunk,
              });
              record('reportSnapshotTextChangedChunks');
              record('reportSnapshotTextWrittenBytes', chunk.byteLength);
            }
          } else {
            pending.push({
              area: 'builds',
              collection: blob,
              op: 'appendBytes',
              bytes: chunk,
            });
            record('reportSnapshotTextChangedChunks');
            record('reportSnapshotTextWrittenBytes', chunk.byteLength);
          }
          ordinal++;
          if (pending.length === 16) await flush();
          if (++chunksSinceCheck === 16) {
            assertCurrent();
            await setImmediate();
            chunksSinceCheck = 0;
            assertCurrent();
          }
        };
        const emit = async (chunk: Buffer) => {
          producerHash.update(chunk);
          producedBytes += chunk.byteLength;
          record('reportSnapshotTextHashBytes', chunk.byteLength);
          if (!fragmented) {
            prefix.push(chunk);
            prefixBytes += chunk.byteLength;
            if (prefixBytes <= 16384) return;
            fragmented = true;
            for (const buffered of prefix) await writeChunk(buffered);
            prefix = [];
          } else await writeChunk(chunk);
        };
        for await (const piece of pieces) {
          if (++piecesSinceCheck === 64) {
            assertCurrent();
            await setImmediate();
            piecesSinceCheck = 0;
            assertCurrent();
          }
          if (typeof piece !== 'string') throw Error('Invalid report text chunk');
          // Keep the existing UTF-16/surrogate-safe leaf boundaries and UTF-8 codec.
          for (let at = 0; at < piece.length;) {
            const take = Math.min(1024 - carry.length, piece.length - at);
            carry += piece.slice(at, at + take);
            at += take;
            if (carry.length === 1024) {
              const end = /[\uD800-\uDBFF]/.test(carry.at(-1)!) ? 1023 : 1024;
              await emit(Buffer.from(carry.slice(0, end)));
              carry = carry.slice(end);
            }
          }
        }
        if (/[\uD800-\uDBFF]/.test(carry.at(-1) ?? ''))
          throw Error('Report text ended with an unpaired surrogate');
        if (carry) await emit(Buffer.from(carry));
        if (!fragmented) {
          const text = Buffer.concat(prefix).toString('utf8');
          if (reportSnapshotInlineTextFits(text)) {
            await result.put(key, text);
            return;
          }
          fragmented = true;
          for (const buffered of prefix) await writeChunk(buffered);
          prefix = [];
        }
        await flush();
        // Delete only the exact suffix, one checked byte-leaf change per operation.
        while (oldCount > ordinal) {
          pending.push({
            area: 'builds',
            collection: blob,
            op: 'truncateBytes',
            length: --oldCount,
          });
          record('reportSnapshotTextDeletedChunks');
          if (pending.length === 16) await flush();
        }
        await flush();
        if (!producedBytes) {
          await result.put(key, '');
          return;
        }
        // Certify the retained complete text independently before attachment.
        // This counted traversal also proves exact leaf count/order/absence.
        const descriptor = collections.collection(collections.openView(), 'builds', blob);
        if (
          !descriptor ||
          descriptor.kind !== 'bytes' ||
          descriptor.bytes !== producedBytes ||
          descriptor.root?.count !== ordinal
        )
          throw Error('Retained report text binding changed');
        const actualHash = createHash('sha256');
        let after: string | undefined,
          verified = 0,
          verifiedBytes = 0;
        for (;;) {
          assertCurrent();
          const page = collections.range(collections.openView(), 'builds', blob, {
            after,
            items: 16,
            bytes: 64 * 1024,
          });
          for (const item of page.items) {
            if (item.key !== schemaOrdinal(verified++))
              throw Error('Retained report text order changed');
            const value = checkedBytes(item.value);
            actualHash.update(value);
            verifiedBytes += value.byteLength;
            record('reportSnapshotTextReadBytes', value.byteLength);
            record('reportSnapshotTextHashBytes', value.byteLength);
          }
          await setImmediate();
          assertCurrent();
          if (page.complete) break;
          if (!page.after || page.after === after)
            throw Error('Retained report text did not advance');
          after = page.after;
        }
        if (
          verified !== ordinal ||
          verifiedBytes !== producedBytes ||
          actualHash.digest('hex') !== producerHash.digest('hex')
        )
          throw Error('Retained report text content changed');
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
    identityScopeReuseReader(snapshotId, requestedArea) {
      if (
        selectedCatalog !== REPORT_SNAPSHOT_CATALOG ||
        !/^identity-(?:current|evidence):[a-f0-9]{64}$/.test(snapshotId)
      )
        throw Error('Invalid identity scope reuse selector');
      const selected = requestedArea === undefined || requestedArea === selectedArea;
      if (selected) {
        const found = open(snapshotId);
        if (found) return { reader: found, area: selectedArea };
        if (requestedArea !== undefined || selectedArea === 'builds') return undefined;
      } else if (requestedArea !== 'builds' || selectedArea !== 'logical')
        throw Error('Foreign identity scope reuse area');
      borrowedIdentityBuild = true;
      assertCurrent();
      if (
        !collections.getCollectionReference(
          collections.openView(),
          'builds',
          REPORT_SNAPSHOT_CATALOG,
          snapshotId,
        )
      )
        return undefined;
      return {
        area: 'builds',
        reader: reader(() => {
          assertCurrent();
          const found = collections.getCollectionReference(
            collections.openView(),
            'builds',
            REPORT_SNAPSHOT_CATALOG,
            snapshotId,
          );
          if (!found) throw Error('Missing accepted build identity alias');
          return found;
        }),
      };
    },
    async bindCurrentIdentityScope(groupId, alias) {
      assertCurrent();
      if (selectedCatalog !== REPORT_SNAPSHOT_CATALOG || selectedArea !== 'builds')
        throw Error('Identity locators require the source report build catalog');
      if (
        !groupId ||
        alias.get('$format') !== 'health-intake-identity-scope-alias-v1' ||
        alias.get('$groupId') !== groupId ||
        alias.get('$intakeId') !== source.id ||
        alias.get('$sourceHash') !== source.sha256
      )
        throw Error('Invalid current identity locator binding');
      const resolve = references.get(alias);
      if (!resolve) throw Error('Foreign identity alias reader');
      const value = await writer(resolve),
        name = names.get(value)!;
      await init();
      await checkpoint([
        {
          area: 'builds',
          collection: catalog,
          op: 'putCollection',
          key: 'identity-current:' + hash(groupId),
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
