/** Complete private name evidence plan. Pages are views, never authority. */
import { createHash, randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { disposableSqlite } from './disposable-sqlite.ts';
import { clinicalReviewRevision, json, type Database } from './database.ts';
import { intakeDiscoveryRevision } from './intake-lookup-state.ts';
import { iterateIntakeIdentityReferences } from './intake-lookup-projection.ts';
import { openIntakeIdentityReference } from './intake-identity-reference.ts';
import {
  prepareIntakeJsonCanonical,
  intakeJsonCanonicalWorkObserver,
} from './intake-json-canonical.ts';
import {
  openIntakeCollectionEnvelope,
  type IntakeCollectionEnvelopeReader,
} from './intake-collection-envelope.ts';
import { canonicalIdentityName, safeSourceIdentityName } from '../shared/self-identity.ts';
import type { OwnershipRequest, OwnershipNameEffect } from '../shared/record-ownership.ts';
import type {
  OwnershipNameHeader,
  OwnershipNameSupportHeader,
  OwnershipNameEvidencePage,
  OwnershipNameEvidenceReference,
} from '../shared/ownership-name-reference.ts';
import { getNote, rememberSourceNameInTransaction } from './notes.ts';
import type { OwnershipScopeIndex } from './ownership-scope-index.ts';
import { ownershipIntakeScopes } from './ownership-intake-scopes.ts';
import { ownershipHash, appendOwnershipDecision } from './ownership-journal.ts';
import { currentTransactionToken, rejectCurrentTransaction } from './database.ts';
import { DatabaseSync, StatementSync } from 'node:sqlite';

const nativeReadPrepare = DatabaseSync.prototype.prepare,
  nativeReadGet = StatementSync.prototype.get;
const readOwners = new WeakMap<
  object,
  {
    db: Database;
    profileId: string;
    current(): boolean;
    sql: DatabaseSync;
  }
>();
declare const readOwnerBrand: unique symbol;
export interface OwnershipNameReadOwner {
  readonly [readOwnerBrand]: true;
}
const readProofs = new WeakMap<
  OwnershipNameReadOwner,
  {
    owner: NonNullable<ReturnType<typeof readOwners.get>>;
    statements: StatementSync[];
    stamp: unknown[];
  }
>();
/** Private name scratch continuity, never a public assertion callback. */
export function captureOwnershipNameReadOwner(plan: object, db: Database, profileId: string) {
  const owner = readOwners.get(plan);
  if (!owner || owner.db !== db || owner.profileId !== profileId || !owner.current())
    throw Error('Ownership name read owner unavailable');
  const statements = [
    'SELECT total_changes() AS value',
    'PRAGMA main.schema_version',
    'PRAGMA temp.schema_version',
    'PRAGMA main.data_version',
  ].map((sql) => Reflect.apply(nativeReadPrepare, owner.sql, [sql]));
  const stamp = statements.map(
    (statement) => Object.values(Reflect.apply(nativeReadGet, statement, [])!)[0],
  );
  const proof = Object.freeze({}) as OwnershipNameReadOwner;
  readProofs.set(proof, { owner, statements, stamp });
  assertOwnershipNameReadOwner(db, proof);
  return proof;
}
export function assertOwnershipNameReadOwner(db: Database, proof: OwnershipNameReadOwner): void {
  const data = readProofs.get(proof);
  if (!data || data.owner.db !== db || !data.owner.current())
    throw Error('Ownership name read owner changed');
  const stamp = data.statements.map(
    (statement) => Object.values(Reflect.apply(nativeReadGet, statement, [])!)[0],
  );
  if (stamp.some((value, index) => value !== data.stamp[index]) || !data.owner.current())
    throw Error('Ownership name read owner changed');
}

export async function prepareOwnershipNamePlan(
  db: Database,
  profileId: string,
  sources: ReadonlySet<string>,
  owners: ReadonlySet<string>,
  request: OwnershipRequest,
  options: {
    assertRunning?: () => void;
    ownedReportScopes?: true;
    scopes?: OwnershipScopeIndex;
  } = {},
) {
  if (db.isTransaction)
    throw Error('Ownership evidence preparation requires an outside-transaction phase');
  if (!options.ownedReportScopes) {
    sources = new Set(sources);
    owners = new Set(owners);
  }
  request = structuredClone(request);
  const originalAssertRunning = options.assertRunning;
  const scratch = disposableSqlite('fictional-ownership-name-plan-');
  const sql = scratch.db;
  const selectedRevision = clinicalReviewRevision(db),
    frontier = intakeDiscoveryRevision(db);
  let closed = false,
    visited = 0;
  const work = {
    targetsVisited: 0,
    receiptStreams: 0,
    canonicalInputCodeUnits: 0,
    peakCanonicalBufferBytes: 0,
    scratchCacheKiB: 2048,
    maxPageItems: 32,
  };
  const assertStable = () => {
    try {
      originalAssertRunning?.();
      if (
        closed ||
        !db.isOpen ||
        db.prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'").get()?.value !==
          profileId ||
        clinicalReviewRevision(db) !== selectedRevision
      )
        throw Error('Ownership name evidence changed; prepare a fresh plan');
    } catch (error) {
      if (currentTransactionToken(db)) rejectCurrentTransaction(db, error);
      throw error;
    }
  };
  const assertCurrent = () => {
    assertStable();
    try {
      if (intakeDiscoveryRevision(db) !== frontier)
        throw Error('Ownership name evidence source frontier changed; prepare a fresh plan');
    } catch (error) {
      if (currentTransactionToken(db)) rejectCurrentTransaction(db, error);
      throw error;
    }
  };
  try {
    assertCurrent();
    sql.exec(`CREATE TABLE effects(key TEXT PRIMARY KEY,note_id TEXT,person_id TEXT,canonical TEXT,name TEXT,candidate INTEGER DEFAULT 0,proposed TEXT,decision TEXT,independent INTEGER,unknown_support INTEGER);
      CREATE TABLE supports(id INTEGER PRIMARY KEY,effect TEXT,operation_id TEXT,intake_id TEXT,group_id TEXT,version TEXT,affected INTEGER,moves INTEGER,target_total INTEGER,source_id TEXT,address TEXT);
      CREATE INDEX supports_effect ON supports(effect,id);
      CREATE TABLE targets(support INTEGER,ordinal INTEGER,record_id TEXT,PRIMARY KEY(support,ordinal));
      CREATE TABLE affected(effect TEXT,record_id TEXT,ordinal INTEGER,PRIMARY KEY(effect,record_id));
      CREATE TABLE scopes(intake_id TEXT,group_id TEXT,record_id TEXT,ordinal INTEGER,PRIMARY KEY(intake_id,group_id,record_id));
      CREATE TABLE owner_notes(person_id TEXT PRIMARY KEY,note_id TEXT NOT NULL,ordinal INTEGER NOT NULL);
      CREATE INDEX owner_notes_note ON owner_notes(note_id,ordinal);
      CREATE TABLE choices(key TEXT PRIMARY KEY,outcome TEXT);`);
    let affectedOrdinal = 0,
      scopeOrdinal = 0;
    const addAffected = (effect: string, id: string) =>
      sql
        .prepare('INSERT OR IGNORE INTO affected VALUES(?,?,?)')
        .run(effect, id, affectedOrdinal++);
    const tick = async () => {
      if (++visited % 64 === 0) {
        assertStable();
        await setImmediate();
        assertStable();
      }
    };
    for (const id of sources) {
      const row = db
        .prepare('SELECT source_file_id,locator_json FROM source_records WHERE id=?')
        .get(id);
      if (!row) continue;
      const locator = json(row.locator_json) as { originalSourceFileId?: string };
      const intakeId = locator.originalSourceFileId || String(row.source_file_id);
      for (const group of options.scopes
        ? options.scopes.scopes(intakeId, id, { subject: false })
        : ownershipIntakeScopes(db, intakeId, id, { subject: false })) {
        sql
          .prepare('INSERT OR IGNORE INTO scopes VALUES(?,?,?,?)')
          .run(intakeId, group.id, id, scopeOrdinal++);
        await tick();
      }
    }
    let ownerOrdinal = 0;
    for (const person of owners) {
      const row = db
        .prepare("SELECT id FROM notes WHERE kind='person' AND person_id=?")
        .get(person);
      if (row)
        sql
          .prepare('INSERT INTO owner_notes VALUES(?,?,?)')
          .run(person, String(row.id), ownerOrdinal++);
      await tick();
    }
    const ownerNote = sql.prepare('SELECT note_id FROM owner_notes WHERE person_id=?'),
      noteOwner = sql.prepare(
        'SELECT person_id FROM owner_notes WHERE note_id=? ORDER BY ordinal LIMIT 1',
      );
    const effectFor = (person: string, name: string) => {
      const note = ownerNote.get(person)?.note_id;
      if (!note) return undefined;
      const canonical = canonicalIdentityName(name),
        key = ownershipHash([note, canonical]);
      sql
        .prepare(
          'INSERT OR IGNORE INTO effects(key,note_id,person_id,canonical,name) VALUES(?,?,?,?,?)',
        )
        .run(key, note, person, canonical, name);
      return key;
    };
    const reportAffected = (intake: string, group: string) =>
      request.selection.type === 'report' &&
      request.selection.intakeId === intake &&
      request.selection.groupId === group;
    const superseded = (operation: string) =>
      !!db
        .prepare(
          "SELECT 1 FROM manual_batches WHERE title='Identity receipt supersession' AND COALESCE(CAST(json_extract(coverage_json,'$.supportOperationId') AS TEXT),'null')=? LIMIT 1",
        )
        .get(operation);
    // Correction candidates precede receipt candidates in the legacy oracle.
    for (const row of db
      .prepare("SELECT coverage_json FROM manual_batches WHERE title='Ownership name support'")
      .iterate()) {
      const value = json(row.coverage_json) as {
        operationId: string;
        noteId: string;
        name: string;
        sourceRecordId: string;
        intakeId: string;
        groupId: string;
      };
      const person = noteOwner.get(value.noteId)?.person_id;
      if (!person || superseded(value.operationId)) continue;
      const key = effectFor(String(person), value.name);
      if (!key) continue;
      if (sources.has(value.sourceRecordId) || reportAffected(value.intakeId, value.groupId))
        sql.prepare('UPDATE effects SET candidate=1,name=? WHERE key=?').run(value.name, key);
      await tick();
    }
    for (const reference of iterateIntakeIdentityReferences(db)) {
      const opened = openIntakeIdentityReference(reference),
        h = opened.header;
      const key = effectFor(h.personId, h.printedName);
      if (!key || superseded(h.operationId)) continue;
      const support = sql
        .prepare(
          'INSERT INTO supports(effect,operation_id,intake_id,group_id,version,affected,moves,target_total) VALUES(?,?,?,?,?,0,0,0)',
        )
        .run(key, h.operationId, h.intakeId, h.groupId, '');
      const supportId = Number(support.lastInsertRowid);
      let total = 0,
        affected = false,
        moves = true;
      for (const id of opened.targetIds()) {
        work.targetsVisited++;
        sql.prepare('INSERT INTO targets VALUES(?,?,?)').run(supportId, total++, id);
        if (sources.has(id)) affected = true;
        else moves = false;
        await tick();
      }
      const version = reference.mode === 'legacy' ? ownershipHash(reference.value) : '';
      if (reference.mode === 'native')
        sql
          .prepare('UPDATE supports SET source_id=?,address=? WHERE id=?')
          .run(reference.sourceId, reference.view.address(reference.record), supportId);
      sql
        .prepare('UPDATE supports SET version=?,affected=?,moves=?,target_total=? WHERE id=?')
        .run(version, Number(affected), Number(total > 0 && moves), total, supportId);
      if (
        (affected || reportAffected(h.intakeId, h.groupId)) &&
        h.printedName &&
        safeSourceIdentityName(h.printedName)
      )
        sql.prepare('UPDATE effects SET candidate=1,name=? WHERE key=?').run(h.printedName, key);
      await tick();
    }
    // Correction support follows the receipt ledger, preserving its array order.
    for (const row of db
      .prepare("SELECT coverage_json FROM manual_batches WHERE title='Ownership name support'")
      .iterate()) {
      const value = json(row.coverage_json) as {
        operationId: string;
        noteId: string;
        name: string;
        sourceRecordId: string;
        intakeId: string;
        groupId: string;
      };
      const person = noteOwner.get(value.noteId)?.person_id;
      if (!person || superseded(value.operationId)) continue;
      const key = effectFor(String(person), value.name);
      if (!key) continue;
      const affected = sources.has(value.sourceRecordId);
      const support = sql
        .prepare(
          'INSERT INTO supports(effect,operation_id,intake_id,group_id,version,affected,moves,target_total) VALUES(?,?,?,?,?,?,?,1)',
        )
        .run(
          key,
          value.operationId,
          value.intakeId,
          value.groupId,
          ownershipHash(value),
          Number(affected),
          Number(affected),
        );
      sql
        .prepare('INSERT INTO targets VALUES(?,0,?)')
        .run(Number(support.lastInsertRowid), value.sourceRecordId);
      if (affected) addAffected(key, value.sourceRecordId);
      await tick();
    }
    for (const owner of sql
      .prepare('SELECT person_id,note_id FROM owner_notes ORDER BY ordinal')
      .iterate()) {
      const person = String(owner.person_id),
        noteId = String(owner.note_id);
      const note = getNote(db, noteId);
      for (const name of note.person.sourceKnownNames || []) {
        if (!safeSourceIdentityName(name.name)) continue;
        const key = effectFor(person, name.name);
        if (!key) continue;
        if (
          reportAffected(name.intakeId, name.groupId) ||
          sql
            .prepare('SELECT 1 FROM scopes WHERE intake_id=? AND group_id=? LIMIT 1')
            .get(name.intakeId, name.groupId)
        )
          sql.prepare('UPDATE effects SET candidate=1,name=? WHERE key=?').run(name.name, key);
      }
      for (const row of sql
        .prepare('SELECT * FROM effects WHERE note_id=? AND candidate=1')
        .iterate(noteId)) {
        const key = String(row.key),
          canonical = String(row.canonical);
        // Transferred affected sources were inserted first, as in the full oracle.
        for (const target of sql
          .prepare(
            'SELECT t.record_id FROM supports s JOIN targets t ON t.support=s.id WHERE s.effect=? ORDER BY s.id,t.ordinal',
          )
          .iterate(key))
          if (sources.has(String(target.record_id))) addAffected(key, String(target.record_id));
        for (const name of note.person.sourceKnownNames || [])
          if (canonicalIdentityName(name.name) === canonical)
            for (const scope of sql
              .prepare(
                'SELECT record_id FROM scopes WHERE intake_id=? AND group_id=? ORDER BY ordinal',
              )
              .iterate(name.intakeId, name.groupId))
              addAffected(key, String(scope.record_id));
        const first = db
          .prepare(
            "SELECT coverage_json FROM manual_batches WHERE title='Remembered name support' AND json_extract(coverage_json,'$.noteId')=? AND json_extract(coverage_json,'$.nameKey')=? ORDER BY json_extract(coverage_json,'$.revision'),id LIMIT 1",
          )
          .get(noteId, canonical);
        const provenance = first
          ? (json(first.coverage_json) as { independentManual?: boolean })
          : null;
        const manual = db
          .prepare(
            "SELECT json_extract(coverage_json,'$.active') active FROM manual_batches WHERE title='Manual name assertion' AND json_extract(coverage_json,'$.noteId')=? AND json_extract(coverage_json,'$.nameKey')=? ORDER BY json_extract(coverage_json,'$.revision') DESC,id DESC LIMIT 1",
          )
          .get(noteId, canonical);
        const supportTotal = Number(
          sql.prepare('SELECT COUNT(*) n FROM supports WHERE effect=?').get(key)!.n,
        );
        const independent =
          (!!note.person.fullName && canonicalIdentityName(note.person.fullName) === canonical) ||
          (manual ? !!manual.active : provenance?.independentManual === true) ||
          !!sql.prepare('SELECT 1 FROM supports WHERE effect=? AND moves=0 LIMIT 1').get(key);
        const unknown = !provenance || provenance.independentManual === undefined || !supportTotal;
        const proposed = !independent && !unknown ? 'destination' : 'unresolved';
        const decision = request.nameDecisions?.find((d) => d.key === key)?.outcome || proposed;
        sql
          .prepare(
            'UPDATE effects SET proposed=?,decision=?,independent=?,unknown_support=? WHERE key=?',
          )
          .run(proposed, decision, Number(independent), Number(unknown), key);
        await tick();
      }
    }
    sql.exec('DELETE FROM effects WHERE candidate=0');
    // Candidate headers/membership are complete before unknown JSON hashing.
    // Native receipt handles stay in private scratch and are re-authorized from
    // their original first-selected source; unrelated names never stream payloads.
    let receiptView: IntakeCollectionEnvelopeReader | undefined, receiptSource: string | undefined;
    for (const support of sql
      .prepare(
        'SELECT s.id,s.source_id,s.address FROM supports s JOIN effects e ON e.key=s.effect WHERE s.source_id IS NOT NULL ORDER BY s.id',
      )
      .iterate()) {
      assertStable();
      if (receiptSource !== support.source_id) {
        receiptSource = String(support.source_id);
        receiptView = openIntakeCollectionEnvelope(
          db,
          { id: receiptSource },
          { fieldSelection: 'first' },
        );
      }
      const record = receiptView!.resolve(String(support.address));
      const canonical = await prepareIntakeJsonCanonical(receiptView!.recordChunks(record), {
        assertRunning: assertStable,
        onWork: intakeJsonCanonicalWorkObserver(db, 'warm'),
      });
      try {
        work.receiptStreams++;
        work.canonicalInputCodeUnits += canonical.work.inputCodeUnits;
        work.peakCanonicalBufferBytes = Math.max(
          work.peakCanonicalBufferBytes,
          canonical.work.maxBufferBytes,
        );
        const digest = createHash('sha256');
        for (const piece of canonical.chunks()) digest.update(piece);
        sql
          .prepare('UPDATE supports SET version=? WHERE id=?')
          .run(digest.digest('hex'), support.id);
      } finally {
        canonical.close();
      }
      await tick();
    }
    const header = (row: Record<string, unknown>): OwnershipNameHeader => ({
      key: String(row.key),
      noteId: String(row.note_id),
      personId: String(row.person_id),
      name: String(row.name),
      proposed: row.proposed as OwnershipNameEffect['proposed'],
      decision: row.decision as OwnershipNameEffect['decision'],
      independentSupport: !!row.independent,
      unknownSupport: !!row.unknown_support,
      supportTotal: Number(
        sql.prepare('SELECT COUNT(*) n FROM supports WHERE effect=?').get(String(row.key))!.n,
      ),
      affectedSourceTotal: Number(
        sql.prepare('SELECT COUNT(*) n FROM affected WHERE effect=?').get(String(row.key))!.n,
      ),
    });
    const supportHeader = (row: Record<string, unknown>): OwnershipNameSupportHeader => ({
      ordinal: Number(row.id),
      operationId: String(row.operation_id),
      intakeId: String(row.intake_id),
      groupId: String(row.group_id),
      version: String(row.version),
      affected: !!row.affected,
      moves: !!row.moves,
      targetTotal: Number(row.target_total),
    });
    function* canonicalEffects(): Generator<string> {
      yield '[';
      let comma = false;
      for (const row of sql.prepare('SELECT * FROM effects ORDER BY key').iterate()) {
        if (comma) yield ',';
        comma = true;
        const h = header(row);
        yield '{"affectedSourceIds":[';
        let sep = false;
        for (const r of sql
          .prepare('SELECT record_id FROM affected WHERE effect=? ORDER BY ordinal')
          .iterate(h.key)) {
          if (sep) yield ',';
          sep = true;
          yield JSON.stringify(r.record_id);
        }
        yield '],"decision":' +
          JSON.stringify(h.decision) +
          ',"independentSupport":' +
          h.independentSupport +
          ',"key":' +
          JSON.stringify(h.key) +
          ',"name":' +
          JSON.stringify(h.name) +
          ',"noteId":' +
          JSON.stringify(h.noteId) +
          ',"personId":' +
          JSON.stringify(h.personId) +
          ',"proposed":' +
          JSON.stringify(h.proposed) +
          ',"support":[';
        sep = false;
        for (const r of sql
          .prepare('SELECT * FROM supports WHERE effect=? ORDER BY id')
          .iterate(h.key)) {
          if (sep) yield ',';
          sep = true;
          const s = supportHeader(r);
          yield '{"affected":' +
            s.affected +
            ',"groupId":' +
            JSON.stringify(s.groupId) +
            ',"intakeId":' +
            JSON.stringify(s.intakeId) +
            ',"moves":' +
            s.moves +
            ',"operationId":' +
            JSON.stringify(s.operationId) +
            ',"sourceRecordIds":[';
          let targetSep = false;
          for (const target of sql
            .prepare('SELECT record_id FROM targets WHERE support=? ORDER BY ordinal')
            .iterate(s.ordinal)) {
            if (targetSep) yield ',';
            targetSep = true;
            yield JSON.stringify(target.record_id);
          }
          yield '],"version":' + JSON.stringify(s.version) + '}';
        }
        yield '],"unknownSupport":' + h.unknownSupport + '}';
      }
      yield ']';
    }
    const digest = createHash('sha256');
    for (const piece of canonicalEffects()) digest.update(piece);
    const token = randomUUID();
    const reference: OwnershipNameEvidenceReference = {
      token,
      digest: digest.digest('hex'),
      decisionDigest: ownershipHash([]),
      total: Number(sql.prepare('SELECT COUNT(*) n FROM effects').get()!.n),
      supportTotal: Number(
        sql.prepare('SELECT COUNT(*) n FROM supports s JOIN effects e ON e.key=s.effect').get()!.n,
      ),
      targetTotal: Number(
        sql
          .prepare(
            'SELECT COUNT(*) n FROM targets t JOIN supports s ON s.id=t.support JOIN effects e ON e.key=s.effect',
          )
          .get()!.n,
      ),
      complete: true,
      url:
        '/api/profiles/' +
        encodeURIComponent(profileId) +
        '/record-ownership/name-evidence/' +
        token,
    };
    assertCurrent();
    const pageLimit = (limit: number) => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32)
        throw Error('Invalid ownership evidence page size');
      return limit;
    };
    const page = <T>(
      items: T[],
      total: number,
      after: string | null,
      next: (item: T) => string,
    ): OwnershipNameEvidencePage<T> => ({
      items,
      total,
      complete: items.length === 0 || after === null,
      after: items.length && after !== null ? next(items.at(-1)!) : null,
    });
    let stageToken: ReturnType<typeof currentTransactionToken>;
    const prepared = {
      reference,
      work,
      sources,
      owners,
      request,
      selectedRevision,
      assertCurrent,
      assertForTransaction() {
        assertCurrent();
        stageToken = currentTransactionToken(db);
        if (!stageToken) throw Error('Ownership name publication requires the owned transaction');
      },
      has(key: string) {
        assertCurrent();
        return !!sql.prepare('SELECT 1 FROM effects WHERE key=?').get(key);
      },
      choose(key: string, outcome: OwnershipNameEffect['decision']) {
        assertCurrent();
        if (!['old', 'destination', 'both', 'unresolved'].includes(outcome) || !this.has(key))
          throw Error('Ownership name decision is outside this complete plan');
        sql.prepare('UPDATE effects SET decision=? WHERE key=?').run(outcome, key);
        sql
          .prepare(
            'INSERT INTO choices VALUES(?,?) ON CONFLICT(key) DO UPDATE SET outcome=excluded.outcome',
          )
          .run(key, outcome);
        reference.decisionDigest = ownershipHash([reference.decisionDigest, key, outcome]);
      },
      *choices() {
        assertCurrent();
        for (const row of sql.prepare('SELECT key,outcome FROM choices ORDER BY key').iterate())
          yield { key: String(row.key), outcome: row.outcome as OwnershipNameEffect['decision'] };
      },
      approvedChoices() {
        assertCurrent();
        // Immutable during the synchronous approval capture. Subsequent child
        // transactions may change domain pins, but cannot alter this private plan.
        return function* () {
          if (closed) throw Error('Ownership approved decision plan is closed');
          for (const row of sql.prepare('SELECT key,outcome FROM choices ORDER BY key').iterate())
            yield { key: String(row.key), outcome: row.outcome as OwnershipNameEffect['decision'] };
        };
      },
      *groupSourceEffects() {
        assertCurrent();
        for (const row of sql.prepare('SELECT key,person_id FROM effects ORDER BY key').iterate()) {
          const key = String(row.key);
          yield {
            personId: String(row.person_id),
            sourceRecordIds: (function* () {
              for (const value of sql
                .prepare('SELECT record_id FROM affected WHERE effect=? ORDER BY ordinal')
                .iterate(key))
                yield String(value.record_id);
            })(),
          };
        }
      },
      *groupEffects() {
        assertCurrent();
        for (const row of sql.prepare('SELECT * FROM effects ORDER BY key').iterate()) {
          const h = header(row);
          yield {
            personId: h.personId,
            affectedSourceIds: Array.from(
              sql
                .prepare('SELECT record_id FROM affected WHERE effect=? ORDER BY ordinal')
                .iterate(h.key),
              (r) => String(r.record_id),
            ),
          };
        }
      },
      effects(after = '', limit = 16) {
        assertCurrent();
        pageLimit(limit);
        const rows = sql
          .prepare('SELECT * FROM effects WHERE key>? ORDER BY key LIMIT ?')
          .all(after, limit + 1);
        const more = rows.length > limit;
        return page(
          rows.slice(0, limit).map(header),
          reference.total,
          more ? 'more' : null,
          (x) => x.key,
        );
      },
      supports(key: string, after = 0, limit = 16) {
        assertCurrent();
        pageLimit(limit);
        if (!this.has(key)) throw Error('Ownership effect is unavailable');
        const total = Number(
          sql.prepare('SELECT COUNT(*) n FROM supports WHERE effect=?').get(key)!.n,
        );
        const rows = sql
          .prepare('SELECT * FROM supports WHERE effect=? AND id>? ORDER BY id LIMIT ?')
          .all(key, after, limit + 1);
        return page(
          rows.slice(0, limit).map(supportHeader),
          total,
          rows.length > limit ? 'more' : null,
          (x) => String(x.ordinal),
        );
      },
      targets(key: string, support: number, after = -1, limit = 32) {
        assertCurrent();
        pageLimit(limit);
        const row = sql
          .prepare(
            'SELECT target_total FROM supports s JOIN effects e ON e.key=s.effect WHERE s.effect=? AND s.id=?',
          )
          .get(key, support);
        if (!row) throw Error('Ownership support is unavailable');
        const rows = sql
          .prepare(
            'SELECT ordinal,record_id FROM targets WHERE support=? AND ordinal>? ORDER BY ordinal LIMIT ?',
          )
          .all(support, after, limit + 1);
        return page(
          rows
            .slice(0, limit)
            .map((r) => ({ ordinal: Number(r.ordinal), recordId: String(r.record_id) })),
          Number(row.target_total),
          rows.length > limit ? 'more' : null,
          (x) => String(x.ordinal),
        );
      },
      canonicalEffects,
      close() {
        if (closed) return;
        closed = true;
        scratch.close();
      },
      stage(destinationNoteId: string, operationId: string) {
        if (!db.isTransaction || !stageToken || currentTransactionToken(db) !== stageToken)
          throw Error('Ownership name publication requires the owned atomic transaction');
        // Pins are checked before the host starts changing clinical rows. No
        // asynchronous work occurs in this stage, and all support is already complete.
        for (const row of sql.prepare('SELECT * FROM effects ORDER BY key').iterate()) {
          const h = header(row);
          // Retain one support header at a time; target arrays never enter the journal.
          appendOwnershipDecision(
            db,
            'name-correction:' + operationId + ':' + h.key,
            'Remembered name correction',
            {
              noteId: h.noteId,
              name: h.name,
              status:
                h.decision === 'old' || h.decision === 'both'
                  ? 'active'
                  : h.decision === 'unresolved'
                    ? 'unresolved'
                    : 'superseded',
              operationId,
              supportOperations: [],
              origin: 'ownership',
            },
          );
          for (const s of sql
            .prepare('SELECT * FROM supports WHERE effect=? AND affected=1 ORDER BY id')
            .iterate(h.key))
            appendOwnershipDecision(
              db,
              'identity-supersession:' +
                operationId +
                ':' +
                ownershipHash([h.key, String(s.operation_id)]),
              'Identity receipt supersession',
              {
                operationId,
                supportOperationId: String(s.operation_id),
                noteId: h.noteId,
                name: h.name,
                supportVersion: String(s.version),
              },
            );
          if (h.decision === 'destination' || h.decision === 'both') {
            const supportDigest = createHash('sha256');
            supportDigest.update('[');
            let supportCount = 0;
            for (const affected of sql
              .prepare('SELECT record_id FROM affected WHERE effect=? ORDER BY ordinal')
              .iterate(h.key)) {
              const sourceRecordId = String(affected.record_id);
              const source = db
                .prepare('SELECT source_file_id,locator_json FROM source_records WHERE id=?')
                .get(sourceRecordId);
              if (!source) continue;
              const locator = json(source.locator_json) as { originalSourceFileId?: string };
              const intakeId = locator.originalSourceFileId || String(source.source_file_id);
              const original = db
                .prepare('SELECT sha256 FROM source_files WHERE id=?')
                .get(intakeId);
              if (!original) throw Error('Ownership name original is unavailable');
              const exact = !!sql
                .prepare(
                  'SELECT 1 FROM supports s JOIN targets t ON t.support=s.id WHERE s.effect=? AND t.record_id=? LIMIT 1',
                )
                .get(h.key, sourceRecordId);
              for (const scope of (options.scopes
                ? options.scopes.scopes.bind(options.scopes)
                : (
                    intakeId: string,
                    sourceRecordId: string,
                    scopeOptions: Parameters<typeof ownershipIntakeScopes>[3],
                  ) => ownershipIntakeScopes(db, intakeId, sourceRecordId, scopeOptions))(
                intakeId,
                sourceRecordId,
                {
                  latestOnly: true,
                  ...(exact
                    ? {
                        exactGroups: {
                          has: (group: string) =>
                            !!sql
                              .prepare(
                                'SELECT 1 FROM supports s JOIN targets t ON t.support=s.id WHERE s.effect=? AND t.record_id=? AND s.intake_id=? AND s.group_id=? LIMIT 1',
                              )
                              .get(h.key, sourceRecordId, intakeId, group),
                        },
                      }
                    : {}),
                },
              )) {
                const supportId =
                  'ownership-name-support:' +
                  ownershipHash([operationId, h.key, sourceRecordId, intakeId, scope.id]);
                appendOwnershipDecision(db, supportId, 'Ownership name support', {
                  operationId: supportId,
                  correctionOperationId: operationId,
                  effectKey: h.key,
                  supportOrdinal: supportCount,
                  noteId: destinationNoteId,
                  name: h.name,
                  sourceRecordId,
                  intakeId,
                  groupId: scope.id,
                });
                rememberSourceNameInTransaction(db, destinationNoteId, {
                  intakeId,
                  groupId: scope.id,
                  sourceHash: String(original.sha256),
                  subjectText: scope.subjectText,
                  operationId: supportId,
                  name: h.name,
                });
                if (supportCount++) supportDigest.update(',');
                supportDigest.update(JSON.stringify(supportId));
              }
            }
            supportDigest.update(']');
            appendOwnershipDecision(
              db,
              'name-correction:' + operationId + ':destination:' + h.key,
              'Remembered name correction',
              {
                noteId: destinationNoteId,
                name: h.name,
                status: 'active',
                operationId,
                origin: 'ownership',
                supportOperationsIncluded: false,
                supportOperationsReference: {
                  operationId,
                  effectKey: h.key,
                  total: supportCount,
                  digest: supportDigest.digest('hex'),
                  complete: true,
                  url:
                    '/api/profiles/' +
                    encodeURIComponent(profileId) +
                    '/record-ownership/name-supports/' +
                    encodeURIComponent(operationId) +
                    '?effect=' +
                    encodeURIComponent(h.key),
                },
              },
            );
          }
        }
      },
    };
    readOwners.set(prepared, {
      db,
      profileId,
      sql,
      current: () => !closed && db.isOpen && sql.isOpen,
    });
    return prepared;
  } catch (error) {
    closed = true;
    scratch.close();
    throw error;
  }
}
export type PreparedOwnershipNamePlan = Awaited<ReturnType<typeof prepareOwnershipNamePlan>>;
