/** Exact selected record identities and their complete source fan-in use private rows. */
import { disposableSqlite } from './disposable-sqlite.ts';
import { clinicalReviewRevision, HttpError, type Database } from './database.ts';
import { intakeDiscoveryRevision } from './intake-lookup-state.ts';
import { iterateOwnershipStreamContributions } from './ownership-contribution-stream.ts';
import { ownershipHash } from './ownership-journal.ts';
import { setImmediate } from 'node:timers/promises';
import type { OwnershipRequest, OwnershipPreview } from '../shared/record-ownership.ts';
import type { ClinicalKind } from './clinical-references.ts';
export async function prepareOwnershipRecordsSelection(
  db: Database,
  profileId: string,
  request: OwnershipRequest,
  options: { assertRunning?: () => void } = {},
) {
  if (request.selection.type !== 'records' || db.isTransaction)
    throw Error('Selected records require outside-transaction preparation');
  const input = request.selection,
    selectedRevision = clinicalReviewRevision(db),
    frontier = intakeDiscoveryRevision(db),
    scratch = disposableSqlite('ownership-records-selection-'),
    sql = scratch.db;
  let closed = false;
  const assertCurrent = () => {
    options.assertRunning?.();
    if (
      closed ||
      !db.isOpen ||
      db.prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'").get()?.value !==
        profileId ||
      clinicalReviewRevision(db) !== selectedRevision ||
      intakeDiscoveryRevision(db) !== frontier
    )
      throw new HttpError(
        409,
        'OWNERSHIP_CHANGED',
        'Selected records or their source evidence changed; prepare a fresh preview',
      );
  };
  try {
    sql.exec(
      'CREATE TABLE sources(id TEXT PRIMARY KEY,ordinal INTEGER);CREATE TABLE refs(kind TEXT,record_id TEXT,ordinal INTEGER,value TEXT,PRIMARY KEY(kind,record_id));CREATE TABLE sorted(rank INTEGER PRIMARY KEY,kind TEXT,record_id TEXT);',
    );
    let ordinal = 0,
      visited = 0;
    for (const record of input.records) {
      assertCurrent();
      sql
        .prepare('INSERT INTO refs VALUES(?,?,?,?)')
        .run(record.kind, record.recordId, ordinal, JSON.stringify(record));
      sql.prepare('INSERT INTO sorted VALUES(?,?,?)').run(ordinal++, record.kind, record.recordId);
      for (const source of iterateOwnershipStreamContributions(db, record.kind, record.recordId, {
        scopes: () => [],
      })) {
        sql
          .prepare('INSERT OR IGNORE INTO sources VALUES(?,?)')
          .run(source.sourceRecordId, visited++);
        if (visited % 32 === 0) {
          await setImmediate();
          assertCurrent();
        }
      }
    }
    const values = function* (): Generator<string, undefined> {
      assertCurrent();
      for (const row of sql.prepare('SELECT id FROM sources ORDER BY ordinal').iterate())
        yield String(row.id);
      return undefined;
    };
    const sources: ReadonlySet<string> = {
      get size() {
        return Number(sql.prepare('SELECT COUNT(*) n FROM sources').get()!.n);
      },
      has: (id) => !!sql.prepare('SELECT 1 FROM sources WHERE id=?').get(id),
      keys: values,
      values,
      [Symbol.iterator]: values,
      *entries(): Generator<[string, string], undefined> {
        for (const id of values()) yield [id, id] as [string, string];
        return undefined;
      },
      forEach(callback, thisArg) {
        for (const id of values()) callback.call(thisArg, id, id, sources);
      },
    };
    return {
      sql,
      view: undefined,
      sources,
      boundary: ownershipHash(input),
      selectedRevision,
      assertCurrent,
      reference: {
        format: 'ownership-records-selection-v1',
        selectionDigest: ownershipHash(input),
        sourceTotal: sources.size,
        recordTotal: input.records.length,
        pendingTotal: 0,
      },
      *records() {
        assertCurrent();
        for (const row of sql.prepare('SELECT value FROM refs ORDER BY ordinal').iterate())
          yield JSON.parse(String(row.value)) as {
            kind: ClinicalKind;
            recordId: string;
            version?: string;
          };
      },
      hasRecord: (kind: string, id: string) =>
        !!sql.prepare('SELECT 1 FROM refs WHERE kind=? AND record_id=?').get(kind, id),
      *pending(): Generator<OwnershipPreview['pending'][number]> {},
      *occurrences(): Generator<string> {},
      close() {
        if (closed) return;
        closed = true;
        scratch.close();
      },
    };
  } catch (error) {
    scratch.close();
    throw error;
  }
}
