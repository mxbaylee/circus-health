/** Private bounded-memory preview store for a complete native report action. */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { ownershipHash } from './ownership-journal.ts';
import type { OwnershipPreview, OwnershipPreviewRecord } from '../shared/record-ownership.ts';
import type {
  OwnershipBlockerReference,
  OwnershipContributionReference,
  OwnershipReportPreviewRecord,
  OwnershipMatchEvidenceReference,
} from '../shared/ownership-report-reference.ts';
import type { OwnershipStreamContribution } from './ownership-contribution-stream.ts';
export interface OwnershipMutableSet extends ReadonlySet<string> {
  add(value: string): void;
}
export interface OwnershipPreviewSink {
  sources: OwnershipMutableSet;
  owners: OwnershipMutableSet;
  relationships: {
    set(key: string, value: OwnershipPreview['relationships'][number]): unknown;
    has(key: string): boolean;
    values(): Iterable<OwnershipPreview['relationships'][number]>;
  };
  blockerBucket(
    key: string,
    reset?: boolean,
  ): {
    push(...values: string[]): void;
    values(): Iterable<string>;
    reference(): OwnershipBlockerReference;
    presentation(): string[] | OwnershipBlockerReference;
  };
  record(record: OwnershipReportPreviewRecord): void;
  contributions(
    kind: string,
    recordId: string,
    values: Iterable<OwnershipStreamContribution>,
    selected: (id: string) => boolean,
  ): OwnershipContributionReference;
  contributionSteps(
    kind: string,
    recordId: string,
    values: Iterable<OwnershipStreamContribution>,
    selected: (id: string) => boolean,
  ): Generator<void, OwnershipContributionReference>;
  matchEvidence(
    kind: string,
    recordId: string,
    values: Iterable<OwnershipPreviewRecord['matches'][number]['evidence'][number]>,
  ): OwnershipMatchEvidenceReference;
  matchEvidenceSteps(
    kind: string,
    recordId: string,
    values: Iterable<OwnershipPreviewRecord['matches'][number]['evidence'][number]>,
  ): Generator<void, OwnershipMatchEvidenceReference>;
  pending(record: OwnershipPreview['pending'][number]): void;
  pin(value: string): void;
  hasRecord(id: string): boolean;
  readonly recordCount: number;
  readonly pendingCount: number;
  readonly digest: string;
}
export class OwnershipStoredSequence<T> implements Iterable<T> {
  private sql: DatabaseSync;
  private table: string;
  private predicate: string;
  constructor(sql: DatabaseSync, table: string, predicate = '1') {
    this.sql = sql;
    this.table = table;
    this.predicate = predicate;
  }
  get length() {
    return Number(
      this.sql.prepare(`SELECT COUNT(*) n FROM ${this.table} WHERE ${this.predicate}`).get()!.n,
    );
  }
  *[Symbol.iterator](): Generator<T> {
    for (const row of this.sql
      .prepare(`SELECT value FROM ${this.table} WHERE ${this.predicate} ORDER BY ordinal`)
      .iterate())
      yield JSON.parse(String(row.value)) as T;
  }
  some(test: (item: T) => boolean) {
    for (const item of this) if (test(item)) return true;
    return false;
  }
  every(test: (item: T) => boolean) {
    for (const item of this) if (!test(item)) return false;
    return true;
  }
  filter(test: (item: T) => boolean): OwnershipFilteredSequence<T> {
    return new OwnershipFilteredSequence(this, test);
  }
}
class OwnershipFilteredSequence<T> implements Iterable<T> {
  private values: Iterable<T>;
  private test: (item: T) => boolean;
  constructor(values: Iterable<T>, test: (item: T) => boolean) {
    this.values = values;
    this.test = test;
  }
  *[Symbol.iterator]() {
    for (const item of this.values) if (this.test(item)) yield item;
  }
  get length() {
    let count = 0;
    for (const _item of this) count++;
    return count;
  }
}
export function createOwnershipPreviewStore(
  sql: DatabaseSync,
  sources: ReadonlySet<string>,
  evidenceUrl: string,
) {
  sql.exec(`CREATE TABLE preview_records(ordinal INTEGER PRIMARY KEY,id TEXT,kind TEXT,value TEXT,blocked INTEGER,UNIQUE(id,kind));
    CREATE INDEX preview_record_ids ON preview_records(id);
    CREATE TABLE preview_pending(ordinal INTEGER PRIMARY KEY,value TEXT);
    CREATE TABLE preview_relationships(ordinal INTEGER PRIMARY KEY,id TEXT UNIQUE,value TEXT);
    CREATE TABLE owners(id TEXT PRIMARY KEY);
    CREATE TABLE preview_contributions(record_key TEXT, ordinal INTEGER,source_id TEXT,value TEXT,selected INTEGER,PRIMARY KEY(record_key,ordinal),UNIQUE(record_key,source_id));
    CREATE TABLE preview_contribution_scopes(record_key TEXT,source_id TEXT,ordinal INTEGER,value TEXT,PRIMARY KEY(record_key,source_id,ordinal));`);
  let pinHash = createHash('sha256'),
    recordHash = createHash('sha256'),
    pendingHash = createHash('sha256');
  let recordOrdinal = 0,
    pendingOrdinal = 0,
    relationshipOrdinal = 0,
    recordBlockerTotal = 0;
  const ids = function* (): Generator<string, undefined> {
    for (const row of sql.prepare('SELECT id FROM owners ORDER BY id').iterate())
      yield String(row.id);
    return undefined;
  };
  const owners: OwnershipMutableSet = {
    get size() {
      return Number(sql.prepare('SELECT COUNT(*) n FROM owners').get()!.n);
    },
    has: (id) => !!sql.prepare('SELECT 1 FROM owners WHERE id=?').get(id),
    add: (id) => {
      sql.prepare('INSERT OR IGNORE INTO owners VALUES(?)').run(id);
    },
    keys: ids,
    values: ids,
    [Symbol.iterator]: ids,
    *entries(): Generator<[string, string], undefined> {
      for (const id of ids()) yield [id, id];
      return undefined;
    },
    forEach(callback, thisArg) {
      for (const id of ids()) callback.call(thisArg, id, id, owners);
    },
  };
  const mutableSources: OwnershipMutableSet = {
    ...sources,
    get size() {
      return sources.size;
    },
    has: (id) => sources.has(id),
    add(id) {
      if (!sources.has(id))
        throw Error('Ownership record escaped its complete selected report scope');
    },
    keys: () => sources.keys(),
    values: () => sources.values(),
    entries: () => sources.entries(),
    [Symbol.iterator]: () => sources[Symbol.iterator](),
    forEach: (callback, thisArg) => sources.forEach(callback, thisArg),
  };
  const relationships: OwnershipPreviewSink['relationships'] = {
    set(id, value) {
      sql
        .prepare(
          'INSERT INTO preview_relationships VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value',
        )
        .run(relationshipOrdinal++, id, JSON.stringify(value));
      return this;
    },
    has: (id) => !!sql.prepare('SELECT 1 FROM preview_relationships WHERE id=?').get(id),
    *values() {
      yield* new OwnershipStoredSequence<OwnershipPreview['relationships'][number]>(
        sql,
        'preview_relationships',
      );
    },
  };
  const sink: OwnershipPreviewSink = {
    blockerBucket(label, reset = true) {
      const key = ownershipHash(['blockers', label]);
      if (reset) sql.prepare('DELETE FROM preview_contributions WHERE record_key=?').run(key);
      let count = Number(
        sql.prepare('SELECT COUNT(*) n FROM preview_contributions WHERE record_key=?').get(key)!.n,
      );
      const values = function* () {
        for (const row of sql
          .prepare('SELECT value FROM preview_contributions WHERE record_key=? ORDER BY ordinal')
          .iterate(key))
          yield JSON.parse(String(row.value)) as string;
      };
      return {
        push(...items) {
          for (const item of items) {
            const result = sql
              .prepare('INSERT OR IGNORE INTO preview_contributions VALUES(?,?,?,?,0)')
              .run(key, count, ownershipHash(item), JSON.stringify(item));
            if (result.changes) count++;
          }
        },
        values,
        presentation() {
          const result: string[] = [];
          let bytes = 2;
          for (const value of values()) {
            bytes += Buffer.byteLength(JSON.stringify(value)) + 1;
            if (bytes > 65536) return this.reference();
            result.push(value);
          }
          return result;
        },
        reference() {
          const hash = createHash('sha256').update('[');
          let first = true;
          for (const value of values()) {
            if (!first) hash.update(',');
            first = false;
            hash.update(JSON.stringify(value));
          }
          return {
            format: 'ownership-blockers-v1',
            key,
            count,
            digest: hash.update(']').digest('hex'),
            url: evidenceUrl + '?contribution=' + key,
          };
        },
      };
    },
    sources: mutableSources,
    owners,
    relationships,
    matchEvidence(kind, recordId, values) {
      const steps = this.matchEvidenceSteps(kind, recordId, values);
      for (;;) {
        const step = steps.next();
        if (step.done) return step.value;
      }
    },
    *matchEvidenceSteps(kind, recordId, values) {
      const key = ownershipHash(['match', kind, recordId]);
      sql.prepare('DELETE FROM preview_contributions WHERE record_key=?').run(key);
      let total = 0;
      const hash = createHash('sha256');
      for (const value of values) {
        sql
          .prepare('INSERT INTO preview_contributions VALUES(?,?,?,?,0)')
          .run(key, total, String(total), JSON.stringify(value));
        total++;
        hash.update(ownershipHash(value));
        if (total % 32 === 0) yield;
      }
      return {
        format: 'ownership-match-evidence-v1',
        key,
        total,
        digest: hash.digest('hex'),
        url: evidenceUrl + '?contribution=' + key,
      };
    },
    contributions(kind, recordId, values, selected) {
      const steps = this.contributionSteps(kind, recordId, values, selected);
      for (;;) {
        const step = steps.next();
        if (step.done) return step.value;
      }
    },
    *contributionSteps(kind, recordId, values, selected) {
      const key = ownershipHash([kind, recordId]);
      sql.prepare('DELETE FROM preview_contributions WHERE record_key=?').run(key);
      sql.prepare('DELETE FROM preview_contribution_scopes WHERE record_key=?').run(key);
      let total = 0,
        selectedTotal = 0;
      const hash = createHash('sha256');
      for (const c of values) {
        let scopeTotal = 0;
        const scopeHash = createHash('sha256');
        for (const scope of c.reportScopes()) {
          sql
            .prepare('INSERT INTO preview_contribution_scopes VALUES(?,?,?,?)')
            .run(key, c.sourceRecordId, scopeTotal++, JSON.stringify(scope));
          scopeHash.update(JSON.stringify(scope));
          if (scopeTotal % 32 === 0) yield;
        }
        const included = selected(c.sourceRecordId);
        if (included) selectedTotal++;
        const value = {
          sourceRecordId: c.sourceRecordId,
          sourceFileId: c.sourceFileId,
          reportScopes: {
            total: scopeTotal,
            url:
              evidenceUrl +
              '?contribution=' +
              key +
              '&source=' +
              encodeURIComponent(c.sourceRecordId),
          },
          contentUrl: c.contentUrl,
          locator: c.locator,
          version: c.version,
          selected: included,
          identity: c.identity,
          acceptedMapping: c.acceptedMapping,
        };
        sql
          .prepare('INSERT INTO preview_contributions VALUES(?,?,?,?,?)')
          .run(key, total++, c.sourceRecordId, JSON.stringify(value), Number(included));
        hash.update(ownershipHash(value));
        hash.update(scopeHash.digest('hex'));
        if (total % 32 === 0) yield;
      }
      return {
        format: 'ownership-contributions-v1',
        key,
        total,
        selectedTotal,
        digest: hash.digest('hex'),
        url: evidenceUrl + '?contribution=' + key,
      };
    },
    record(record) {
      const previous = sql
          .prepare('SELECT ordinal,blocked FROM preview_records WHERE id=? AND kind=?')
          .get(record.recordId, record.kind),
        blocked = Number(ownershipBlockerCount(record) > 0);
      recordBlockerTotal += blocked - Number(previous?.blocked ?? 0);
      if (previous)
        sql
          .prepare('UPDATE preview_records SET value=?,blocked=? WHERE ordinal=?')
          .run(JSON.stringify(record), blocked, previous.ordinal);
      else
        sql
          .prepare('INSERT INTO preview_records VALUES(?,?,?,?,?)')
          .run(recordOrdinal++, record.recordId, record.kind, JSON.stringify(record), blocked);
      recordHash.update(ownershipHash(record));
    },
    pending(record) {
      sql
        .prepare('INSERT INTO preview_pending VALUES(?,?)')
        .run(pendingOrdinal++, JSON.stringify(record));
      pendingHash.update(ownershipHash(record));
    },
    pin(value) {
      pinHash.update(JSON.stringify(value));
    },
    hasRecord: (id) => !!sql.prepare('SELECT 1 FROM preview_records WHERE id=?').get(id),
    get recordCount() {
      return recordOrdinal;
    },
    get pendingCount() {
      return pendingOrdinal;
    },
    get digest() {
      return ownershipHash([
        pinHash.copy().digest('hex'),
        recordHash.copy().digest('hex'),
        pendingHash.copy().digest('hex'),
      ]);
    },
  };
  return {
    sink,
    get recordBlockerTotal() {
      return recordBlockerTotal;
    },
    checkpoint() {
      const pins = pinHash.copy(),
        records = recordHash.copy(),
        pending = pendingHash.copy(),
        counts = [recordOrdinal, pendingOrdinal, relationshipOrdinal, recordBlockerTotal];
      return () => {
        pinHash = pins;
        recordHash = records;
        pendingHash = pending;
        [recordOrdinal, pendingOrdinal, relationshipOrdinal, recordBlockerTotal] = counts as [
          number,
          number,
          number,
          number,
        ];
      };
    },
    records: new OwnershipStoredSequence<OwnershipReportPreviewRecord>(sql, 'preview_records'),
    pending: new OwnershipStoredSequence<OwnershipPreview['pending'][number]>(
      sql,
      'preview_pending',
    ),
    relationships: new OwnershipStoredSequence<OwnershipPreview['relationships'][number]>(
      sql,
      'preview_relationships',
    ),
  };
}
export type OwnershipCommitView = Omit<
  OwnershipPreview,
  'records' | 'pending' | 'relationships'
> & {
  blockerEvidence?: OwnershipBlockerReference;
  records: OwnershipPreview['records'] | OwnershipStoredSequence<OwnershipReportPreviewRecord>;
  pending:
    OwnershipPreview['pending'] | OwnershipStoredSequence<OwnershipPreview['pending'][number]>;
  relationships:
    | OwnershipPreview['relationships']
    | OwnershipStoredSequence<OwnershipPreview['relationships'][number]>;
};

/** Native internal header omits its legacy array slot only with this explicit full evidence ref. */
export function ownershipBlockerCount(value: {
  blockers: string[] | OwnershipBlockerReference;
  blockerEvidence?: OwnershipBlockerReference;
}) {
  return (
    value.blockerEvidence?.count ??
    (Array.isArray(value.blockers) ? value.blockers.length : value.blockers.count)
  );
}
