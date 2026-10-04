/** Disposable scalar routing for accepted ownership evidence; journal rows remain authoritative. */
import { setImmediate } from 'node:timers/promises';
import { HttpError, type Database } from './database.ts';
const TABLE = '__ownership_decision_index',
  META = '__ownership_decision_index_state';
const projection = (row: string) =>
  `${row}.id,${row}.title,json_extract(${row}.coverage_json,'$.sourceRecordId'),json_extract(${row}.coverage_json,'$.revision'),json_extract(${row}.coverage_json,'$.duplicateDecision.occurrenceAttachment.incomingSourceRecordId'),json_extract(${row}.coverage_json,'$.duplicateDecision.sequence'),json_extract(${row}.coverage_json,'$.duplicateDecision.right.kind'),json_extract(${row}.coverage_json,'$.duplicateDecision.right.id'),CASE WHEN json_extract(${row}.coverage_json,'$.duplicateDecision.evidence.right.format')='health-duplicate-evidence-snapshot-v1' THEN json_extract(${row}.coverage_json,'$.duplicateDecision.evidence.right') END,json_extract(${row}.coverage_json,'$.duplicateDecision.right.identity'),json_extract(${row}.coverage_json,'$.duplicateDecision.right.sourceRecordId'),json_extract(${row}.coverage_json,'$.recordException.reclassification.recordId'),json_extract(${row}.coverage_json,'$.recordException.reclassification.fromKind'),json_extract(${row}.coverage_json,'$.recordException.reclassification.toKind'),json_extract(${row}.coverage_json,'$.recordException.sequence'),json_extract(${row}.coverage_json,'$.recordException.identityKey')`;
const ddl = [
  `CREATE TEMP TABLE ${TABLE}(id TEXT PRIMARY KEY,title TEXT,source_record_id,revision,transition_source_id,transition_sequence,duplicate_kind,duplicate_record_id,evidence_snapshot,duplicate_identity,duplicate_source_record_id,exception_record_id,exception_from_kind,exception_to_kind,exception_sequence,exception_identity)`,
  `CREATE INDEX temp.__ownership_decision_index_source ON ${TABLE}(title,source_record_id,revision DESC,id DESC)`,
  `CREATE INDEX temp.__ownership_decision_index_transition ON ${TABLE}(title,transition_source_id,transition_sequence,id)`,
  `CREATE INDEX temp.__ownership_decision_index_snapshot ON ${TABLE}(duplicate_kind,duplicate_record_id,transition_sequence DESC,id DESC) WHERE evidence_snapshot IS NOT NULL`,
  `CREATE INDEX temp.__ownership_decision_index_exception ON ${TABLE}(exception_record_id,exception_sequence DESC,id DESC) WHERE exception_record_id IS NOT NULL`,
  `CREATE TEMP TABLE ${META}(singleton INTEGER PRIMARY KEY CHECK(singleton=1),generation INTEGER NOT NULL)`,
  `CREATE TEMP TRIGGER __ownership_decision_index_insert AFTER INSERT ON main.manual_batches BEGIN UPDATE ${META} SET generation=generation+1; INSERT INTO ${TABLE} SELECT ${projection('NEW')}; END`,
  `CREATE TEMP TRIGGER __ownership_decision_index_delete AFTER DELETE ON main.manual_batches BEGIN UPDATE ${META} SET generation=generation+1; DELETE FROM ${TABLE} WHERE id=OLD.id; END`,
  `CREATE TEMP TRIGGER __ownership_decision_index_update AFTER UPDATE ON main.manual_batches BEGIN UPDATE ${META} SET generation=generation+1; DELETE FROM ${TABLE} WHERE id=OLD.id OR id=NEW.id; INSERT INTO ${TABLE} SELECT ${projection('NEW')}; END`,
];
interface State {
  ready: boolean;
  schema: string;
  mainSchema: string;
  dataVersion: number;
  coldRows: number;
}
const states = new WeakMap<Database, State>();
const version = (db: Database) => Number(db.prepare('PRAGMA data_version').get()!.data_version);
const schema = (db: Database) =>
  JSON.stringify(
    db
      .prepare(
        "SELECT type,name,tbl_name,sql FROM sqlite_temp_schema WHERE name LIKE '__ownership_decision_index%' ORDER BY type,name",
      )
      .all(),
  );
const mainSchema = (db: Database) =>
  JSON.stringify(
    db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='manual_batches'").get(),
  );
const unavailable = () =>
  new HttpError(
    409,
    'OWNERSHIP_DECISION_INDEX_PENDING',
    'Prepare complete accepted ownership evidence before reviewing this report',
  );
function checked(db: Database) {
  const state = states.get(db);
  if (
    !state?.ready ||
    state.schema !== schema(db) ||
    state.mainSchema !== mainSchema(db) ||
    state.dataVersion !== version(db)
  ) {
    if (state) state.ready = false;
    throw unavailable();
  }
  return state;
}
export async function prepareOwnershipDecisionIndex(
  db: Database,
  options: { assertRunning?: () => void } = {},
) {
  if (db.isTransaction)
    throw Error('Ownership decision indexing requires outside-transaction preparation');
  try {
    checked(db);
    return;
  } catch (error) {
    if (!(error instanceof HttpError && error.code === 'OWNERSHIP_DECISION_INDEX_PENDING'))
      throw error;
  }
  const state: State = {
    ready: false,
    schema: '',
    mainSchema: '',
    dataVersion: version(db),
    coldRows: 0,
  };
  states.set(db, state);
  for (const event of ['insert', 'delete', 'update'])
    db.exec('DROP TRIGGER IF EXISTS temp.__ownership_decision_index_' + event);
  db.exec('DROP TABLE IF EXISTS temp.' + TABLE);
  db.exec('DROP TABLE IF EXISTS temp.' + META);
  for (const sql of ddl) db.exec(sql);
  db.exec('INSERT INTO ' + META + ' VALUES(1,0)');
  state.schema = schema(db);
  state.mainSchema = mainSchema(db);
  const assertCurrent = () => {
    options.assertRunning?.();
    if (
      version(db) !== state.dataVersion ||
      schema(db) !== state.schema ||
      mainSchema(db) !== state.mainSchema ||
      Number(db.prepare('SELECT generation FROM ' + META).get()?.generation) !== 0
    )
      throw unavailable();
  };
  try {
    const insert = db.prepare('INSERT INTO ' + TABLE + ' VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    for (const row of db
      .prepare('SELECT ' + projection('m') + ' FROM manual_batches m ORDER BY id')
      .iterate()) {
      insert.run(...Object.values(row));
      state.coldRows++;
      if (state.coldRows % 64 === 0) {
        await setImmediate();
        assertCurrent();
      }
    }
    assertCurrent();
    state.ready = true;
  } catch (error) {
    state.ready = false;
    throw error;
  }
}
/** Legacy synchronous hosts retain their existing path until explicit native preparation. */
export function ownershipDecisionQueries(db: Database) {
  if (!states.has(db)) return undefined;
  checked(db);
  return {
    latestDuplicateEvidenceSnapshot(kind: string, recordId: string) {
      checked(db);
      return db
        .prepare(
          `SELECT evidence_snapshot FROM ${TABLE} WHERE duplicate_kind=? AND duplicate_record_id=? AND evidence_snapshot IS NOT NULL ORDER BY transition_sequence DESC,id DESC LIMIT 1`,
        )
        .get(kind, recordId)?.evidence_snapshot;
    },
    *reclassifications(recordId: string) {
      checked(db);
      yield* db
        .prepare(
          `SELECT exception_from_kind AS from_kind,exception_to_kind AS to_kind,exception_identity AS identity FROM ${TABLE} WHERE title='Import record exception' AND exception_record_id=? ORDER BY exception_sequence DESC,id DESC`,
        )
        .iterate(recordId);
    },
    latestDuplicateEvidenceSnapshotIdentity(kind: string, recordId: string) {
      checked(db);
      return db
        .prepare(
          `SELECT evidence_snapshot AS reference,duplicate_kind AS kind,duplicate_identity AS identity,duplicate_source_record_id AS source_record_id,transition_sequence AS sequence FROM ${TABLE} WHERE duplicate_kind=? AND duplicate_record_id=? AND evidence_snapshot IS NOT NULL ORDER BY transition_sequence DESC,id DESC LIMIT 1`,
        )
        .get(kind, recordId);
    },
    accepted(sourceRecordId: string) {
      checked(db);
      return db
        .prepare(
          `SELECT m.coverage_json FROM ${TABLE} i JOIN main.manual_batches m ON m.id=i.id WHERE i.title='Accepted clinical contribution' AND i.source_record_id=? ORDER BY i.revision DESC,i.id DESC LIMIT 1`,
        )
        .get(sourceRecordId);
    },
    *transitions(sourceRecordId: string) {
      checked(db);
      yield* db
        .prepare(
          `SELECT m.id,m.coverage_json FROM ${TABLE} i JOIN main.manual_batches m ON m.id=i.id WHERE i.title='Duplicate evidence decision' AND i.transition_source_id=? ORDER BY i.transition_sequence,i.id`,
        )
        .iterate(sourceRecordId);
    },
  };
}
export function ownershipDecisionIndexWork(db: Database) {
  const state = checked(db);
  return {
    coldRows: state.coldRows,
    changedRows: Number(db.prepare('SELECT generation FROM ' + META).get()!.generation),
  };
}
