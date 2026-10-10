/** Complete native report selection. Presentation cursors never select authority. */
import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { disposableSqlite } from './disposable-sqlite.ts';
import {
  HttpError,
  clinicalReviewRevision,
  currentTransactionToken,
  rejectCurrentTransaction,
  type Database,
} from './database.ts';
import { intakeDiscoveryRevision } from './intake-lookup-state.ts';
import {
  openIntakeCollectionEnvelope,
  type IntakeEnvelopeRecord,
} from './intake-collection-envelope.ts';
import { createReportSnapshotCatalog } from './intake-report-snapshot-catalog.ts';
import { openReportMemberSnapshot } from './intake-report-member-state.ts';
import {
  prepareIntakeJsonCanonical,
  intakeJsonCanonicalWorkObserver,
} from './intake-json-canonical.ts';
import { clinicalTables, type ClinicalKind } from './clinical-references.ts';
import { canonicalLiteral } from './intake-format.ts';
import type { IntakeReportMembersReference } from '../shared/intake-report-version.ts';
import type { OwnershipRequest, OwnershipPreview } from '../shared/record-ownership.ts';

export async function prepareOwnershipReportSelection(
  db: Database,
  profileId: string,
  request: OwnershipRequest,
  options: { assertRunning?: () => void } = {},
) {
  if (request.selection.type !== 'report' || db.isTransaction)
    throw Error('Report selection requires explicit outside-transaction preparation');
  const selection = request.selection,
    selectedRevision = clinicalReviewRevision(db),
    frontier = intakeDiscoveryRevision(db),
    scratch = disposableSqlite('ownership-report-selection-'),
    sql = scratch.db;
  let closed = false,
    visited = 0;
  const assertCurrent = () => {
    try {
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
          'Report membership or clinical evidence changed; prepare a fresh preview',
        );
    } catch (error) {
      if (currentTransactionToken(db)) rejectCurrentTransaction(db, error);
      throw error;
    }
  };
  const tick = async () => {
    if (++visited % 64 === 0) {
      assertCurrent();
      await setImmediate();
      assertCurrent();
    }
  };
  try {
    assertCurrent();
    const source = db
      .prepare(
        "SELECT id,kind,sha256,details_json FROM source_files WHERE id=? AND kind='intake_original'",
      )
      .get(selection.intakeId);
    if (!source) throw new HttpError(404, 'INTAKE_NOT_FOUND', 'Intake original not found');
    const view = openIntakeCollectionEnvelope(db, source as { id: string }),
      intake = view.child(view.root(), 'intake'),
      workflow = intake && view.child(intake, 'workflow');
    const group = workflow && view.find('reportGroup', workflow, selection.groupId);
    const read = (record: IntakeEnvelopeRecord, field: string): unknown => {
      const result = view.field(record, field, { bytes: 65536 });
      if (result.kind === 'fragmented')
        throw Error('Report selection header requires addressed consumption');
      return result.kind === 'value' ? result.value : undefined;
    };
    const text = (record: IntakeEnvelopeRecord, field: string) => {
      const value = read(record, field);
      if (typeof value !== 'string') throw Error('Report selection identity is unavailable');
      return value;
    };
    const version =
      group && view.childAt(group, 'versions', view.childCount(group, 'versions') - 1);
    if (!group || !version || text(version, 'id') !== selection.groupVersionId)
      throw new HttpError(
        409,
        'OWNERSHIP_CHANGED',
        'Report membership changed; review the report again',
      );
    // The report body may be large. Canonicalize its exact selected JS value on
    // disk rather than hydrating a fake group header for the authority hash.
    const reportBody = view.child(group, 'report');
    const body = reportBody
      ? view.recordChunks(reportBody)
      : view.has(group, 'report')
        ? view.fieldChunks(group, 'report')
        : ['null'];
    const canonical = await prepareIntakeJsonCanonical(body, {
      assertRunning: assertCurrent,
      onWork: intakeJsonCanonicalWorkObserver(db, 'warm'),
    });
    let boundary: string;
    try {
      const hash = createHash('sha256');
      hash.update(
        '[' +
          canonicalLiteral(selection.intakeId) +
          ',' +
          canonicalLiteral(String(source.sha256)) +
          ',' +
          canonicalLiteral(text(group, 'id')) +
          ',' +
          canonicalLiteral(read(group, 'memberId') ?? null) +
          ',' +
          canonicalLiteral(read(group, 'sourceFileId') ?? null) +
          ',' +
          canonicalLiteral(read(group, 'sourceHash') ?? null) +
          ',',
      );
      for (const chunk of canonical.chunks()) hash.update(chunk);
      hash.update(']');
      boundary = hash.digest('hex');
    } finally {
      canonical.close();
    }
    sql.exec(`CREATE TABLE sources(id TEXT PRIMARY KEY,ordinal INTEGER NOT NULL);
      CREATE TABLE occurrences(ordinal INTEGER PRIMARY KEY,record_id TEXT NOT NULL,candidate_id TEXT NOT NULL,version_id TEXT NOT NULL);
      CREATE TABLE pending(ordinal INTEGER PRIMARY KEY,record_id TEXT,candidate_id TEXT,version_id TEXT,person_id TEXT);
      CREATE TABLE refs(kind TEXT,record_id TEXT,ordinal INTEGER,PRIMARY KEY(kind,record_id));
      CREATE TABLE sorted(rank INTEGER PRIMARY KEY,kind TEXT,record_id TEXT);
      CREATE TABLE merge(rank INTEGER PRIMARY KEY,kind TEXT,record_id TEXT);`);
    let ordinal = 0;
    const add = async (candidateId: string, candidateVersionId: string, recordId: string) => {
      sql.prepare('INSERT OR IGNORE INTO sources VALUES(?,?)').run(recordId, ordinal);
      sql
        .prepare('INSERT INTO occurrences VALUES(?,?,?,?)')
        .run(ordinal, recordId, candidateId, candidateVersionId);
      const candidate = view.find('candidate', workflow!, candidateId),
        candidateVersion = candidate && view.find('version', candidate, candidateVersionId);
      if (candidateVersion && read(candidateVersion, 'status') === 'pending')
        sql
          .prepare('INSERT INTO pending VALUES(?,?,?,?,NULL)')
          .run(ordinal, recordId, candidateId, candidateVersionId);
      ordinal++;
      await tick();
    };
    const children = function* (parent: IntakeEnvelopeRecord, field: string) {
      const collection = view.child(parent, field);
      if (!collection || view.info(collection).shape !== 'array')
        throw Error('Report selection occurrence collection is unavailable');
      const count = view.childCount(parent, field);
      for (let i = 0; i < count; i++) {
        const item = view.childAt(parent, field, i);
        if (!item) throw Error('Missing report selection occurrence');
        yield item;
      }
    };
    if (read(version, 'format') === 'health-intake-report-group-version-v2') {
      const members = view.child(version, 'members');
      if (!members) throw Error('Report member reference is unavailable');
      const reference = {
        format: read(members, 'format'),
        snapshotId: read(members, 'snapshotId'),
        memberCount: read(members, 'memberCount'),
        occurrenceCount: read(members, 'occurrenceCount'),
      } as IntakeReportMembersReference;
      const snapshot = openReportMemberSnapshot(
        createReportSnapshotCatalog(db, source as { id: string }),
        reference,
      );
      for (let i = 0; i < reference.memberCount; i++) {
        const member = snapshot.memberAt(i);
        if (!member) throw Error('Missing report snapshot member');
        for (let j = 0; j < member.occurrenceCount; j++) {
          const id = snapshot.occurrenceRecordId(member, j);
          if (typeof id !== 'string')
            throw Error('Report ownership occurrence lacks a record identity');
          await add(member.candidateId, member.candidateVersionId, id);
        }
      }
      snapshot.assertCurrent();
    } else
      for (const member of children(version, 'members'))
        for (const occurrence of children(member, 'occurrences'))
          await add(
            text(member, 'candidateId'),
            text(member, 'candidateVersionId'),
            text(occurrence, 'recordId'),
          );
    let refOrdinal = 0;
    for (const sourceId of sql.prepare('SELECT id FROM sources ORDER BY ordinal').iterate()) {
      for (const [kind, table] of Object.entries(clinicalTables))
        for (const row of db
          .prepare(
            `SELECT id FROM ${table} WHERE source_record_id=? UNION SELECT entity_id id FROM evidence WHERE entity_type=? AND source_record_id=?`,
          )
          .iterate(String(sourceId.id), kind, String(sourceId.id)))
          if (db.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(row.id))
            sql
              .prepare('INSERT OR IGNORE INTO refs VALUES(?,?,?)')
              .run(kind, String(row.id), refOrdinal++);
      await tick();
    }
    // Disk merge sort preserves the legacy localeCompare order and stable ties.
    // SQLite binary ordering is not an equivalent Unicode ordering.
    sql
      .prepare(
        'INSERT INTO sorted SELECT row_number() OVER(ORDER BY ordinal)-1,kind,record_id FROM refs',
      )
      .run();
    const count = Number(sql.prepare('SELECT COUNT(*) n FROM sorted').get()!.n);
    for (let width = 1; width < count; width *= 2) {
      sql.exec('DELETE FROM merge');
      let rank = 0;
      for (let start = 0; start < count; start += 2 * width) {
        const left = sql
          .prepare('SELECT kind,record_id FROM sorted WHERE rank>=? AND rank<? ORDER BY rank')
          .iterate(start, Math.min(start + width, count));
        const right = sql
          .prepare('SELECT kind,record_id FROM sorted WHERE rank>=? AND rank<? ORDER BY rank')
          .iterate(start + width, Math.min(start + 2 * width, count));
        let a = left.next(),
          b = right.next();
        while (!a.done || !b.done) {
          const chooseLeft =
            b.done ||
            (!a.done &&
              (String(a.value.kind) + String(a.value.record_id)).localeCompare(
                String(b.value.kind) + String(b.value.record_id),
              ) <= 0);
          const item = chooseLeft ? a.value! : b.value!;
          sql.prepare('INSERT INTO merge VALUES(?,?,?)').run(rank++, item.kind, item.record_id);
          if (chooseLeft) a = left.next();
          else b = right.next();
          await tick();
        }
      }
      sql.exec('DELETE FROM sorted; INSERT INTO sorted SELECT * FROM merge');
    }
    assertCurrent();
    const values = function* (): Generator<string, undefined> {
      for (const row of sql.prepare('SELECT id FROM sources ORDER BY ordinal').iterate())
        yield String(row.id);
      return undefined;
    };
    const sources: ReadonlySet<string> = {
      get size() {
        return Number(sql.prepare('SELECT COUNT(*) n FROM sources').get()!.n);
      },
      has: (id: string) => !!sql.prepare('SELECT 1 FROM sources WHERE id=?').get(id),
      keys: values,
      values,
      [Symbol.iterator]: values,
      *entries(): Generator<[string, string], undefined> {
        for (const value of values()) yield [value, value] as [string, string];
        return undefined;
      },
      forEach(callback, thisArg) {
        for (const value of values()) callback.call(thisArg, value, value, sources);
      },
    };
    return {
      sql,
      view,
      sources,
      boundary,
      selectedRevision,
      assertCurrent,
      reference: {
        intakeId: selection.intakeId,
        groupId: selection.groupId,
        groupVersionId: selection.groupVersionId,
        sourceHash: String(source.sha256),
        logical: view.logical,
        sourceTotal: sources.size,
        recordTotal: count,
        pendingTotal: Number(sql.prepare('SELECT COUNT(*) n FROM pending').get()!.n),
      },
      *records() {
        for (const row of sql.prepare('SELECT kind,record_id FROM sorted ORDER BY rank').iterate())
          yield { kind: row.kind as ClinicalKind, recordId: String(row.record_id) };
      },
      hasRecord(kind: string, id: string) {
        return !!sql.prepare('SELECT 1 FROM refs WHERE kind=? AND record_id=?').get(kind, id);
      },
      *pending(): Generator<OwnershipPreview['pending'][number]> {
        for (const row of sql.prepare('SELECT * FROM pending ORDER BY ordinal').iterate())
          yield {
            recordId: String(row.record_id),
            candidateId: String(row.candidate_id),
            candidateVersionId: String(row.version_id),
            ...(row.person_id ? { personId: String(row.person_id) } : {}),
          };
      },
      *occurrences() {
        for (const row of sql
          .prepare('SELECT record_id FROM occurrences ORDER BY ordinal')
          .iterate())
          yield String(row.record_id);
      },
      close() {
        if (closed) return;
        closed = true;
        scratch.close();
      },
    };
  } catch (error) {
    closed = true;
    scratch.close();
    throw error;
  }
}
export type PreparedOwnershipReportSelection = Awaited<
  ReturnType<typeof prepareOwnershipReportSelection>
>;
