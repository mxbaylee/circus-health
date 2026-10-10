/** Disposable canonical fingerprints. Originals and accepted rows remain the authority. */
import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import type { DatabaseSync } from 'node:sqlite';
import { HttpError } from './database.ts';
import { canonicalLiteral, parseLiteralJSON } from './intake-format.ts';
import { withIntakeWork, recordIntakeWork } from './intake-work-accounting.ts';
import {
  beginIntakeFrontierAuxiliaryPreparation,
  execIntakeFrontierAuxiliarySQL,
  finishIntakeFrontierAuxiliaryPreparation,
  prepareIntakeFrontierAuxiliaryInsert,
  runIntakeFrontierAuxiliaryInsert,
} from './intake-lookup-frontier-observer.ts';

const TABLE = '__clinical_source_fingerprints',
  META = '__clinical_source_fingerprint_state',
  FUNCTION = '__clinical_source_canonical_digest';
const definition = [
  `CREATE TEMP TABLE ${TABLE}(record_id TEXT PRIMARY KEY,provider_id TEXT,digest TEXT NOT NULL)`,
  `CREATE INDEX temp.__clinical_source_fingerprints_lookup ON ${TABLE}(provider_id,digest)`,
  `CREATE TEMP TABLE ${META}(singleton INTEGER PRIMARY KEY CHECK(singleton=1),generation INTEGER NOT NULL)`,
  `CREATE TEMP TRIGGER __clinical_source_fingerprints_insert AFTER INSERT ON main.source_records BEGIN UPDATE ${META} SET generation=generation+1; DELETE FROM ${TABLE} WHERE record_id=NEW.id; INSERT INTO ${TABLE} SELECT NEW.id,NEW.provider_id,${FUNCTION}(NEW.raw_json) WHERE NEW.kind LIKE 'intake_%'; END`,
  `CREATE TEMP TRIGGER __clinical_source_fingerprints_delete AFTER DELETE ON main.source_records BEGIN UPDATE ${META} SET generation=generation+1; DELETE FROM ${TABLE} WHERE record_id=OLD.id; END`,
  `CREATE TEMP TRIGGER __clinical_source_fingerprints_update AFTER UPDATE ON main.source_records BEGIN UPDATE ${META} SET generation=generation+1; DELETE FROM ${TABLE} WHERE record_id=OLD.id OR record_id=NEW.id; INSERT INTO ${TABLE} SELECT NEW.id,NEW.provider_id,${FUNCTION}(NEW.raw_json) WHERE NEW.kind LIKE 'intake_%'; END`,
];
interface State {
  ready: boolean;
  dataVersion: number;
  schema: string;
  mainSchema: string;
  registered: boolean;
}
const states = new WeakMap<DatabaseSync, State>();
const unavailable = () =>
  new HttpError(
    409,
    'CLINICAL_SOURCE_INDEX_PENDING',
    'Prepare complete accepted source fingerprints before clinical acceptance',
  );
const dataVersion = (db: DatabaseSync) =>
  Number(db.prepare('PRAGMA data_version').get()!.data_version);
function schema(db: DatabaseSync) {
  return JSON.stringify(
    db
      .prepare(
        "SELECT type,name,tbl_name,sql FROM sqlite_temp_schema WHERE name LIKE '__clinical_source_fingerprint%' ORDER BY type,name",
      )
      .all(),
  );
}
function mainSchema(db: DatabaseSync) {
  return JSON.stringify(
    db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='source_records'").get(),
  );
}
function canonicalDigest(db: DatabaseSync, raw: unknown, phase: 'warm' | 'reconstruction') {
  const text = String(raw),
    canonical = canonicalLiteral(parseLiteralJSON(text));
  withIntakeWork(db, phase, () => {
    recordIntakeWork(
      phase === 'warm' ? 'clinicalCanonicalIndexChangedRows' : 'clinicalCanonicalIndexColdRows',
    );
    recordIntakeWork(
      phase === 'warm' ? 'clinicalCanonicalIndexChangedBytes' : 'clinicalCanonicalIndexColdBytes',
      Buffer.byteLength(text),
    );
  });
  return createHash('sha256').update(canonical).digest('hex');
}
function checked(db: DatabaseSync): State {
  const state = states.get(db);
  if (
    !state?.ready ||
    state.dataVersion !== dataVersion(db) ||
    state.schema !== schema(db) ||
    state.mainSchema !== mainSchema(db)
  ) {
    if (state) state.ready = false;
    throw unavailable();
  }
  return state;
}
/** Explicit cold preparation once per connection; changed accepted rows maintain TEMP state transactionally. */
export async function prepareClinicalSourceFingerprintIndex(
  db: DatabaseSync,
  options: { assertRunning?: () => void } = {},
): Promise<void> {
  if (db.isTransaction)
    throw Error('Prepare canonical source fingerprints outside the application transaction');
  try {
    checked(db);
    return;
  } catch (error) {
    if (!(error instanceof HttpError && error.code === 'CLINICAL_SOURCE_INDEX_PENDING'))
      throw error;
  }
  let state = states.get(db);
  if (!state) {
    state = { ready: false, dataVersion: 0, schema: '', mainSchema: '', registered: false };
    states.set(db, state);
  }
  state.ready = false;
  const frontier = beginIntakeFrontierAuxiliaryPreparation(db, 'clinical-source');
  let complete = false;
  try {
    if (!state.registered) {
      db.function(FUNCTION, { deterministic: true }, (raw) => canonicalDigest(db, raw, 'warm'));
      state.registered = true;
    }
    for (const event of ['insert', 'delete', 'update'])
      execIntakeFrontierAuxiliarySQL(
        db,
        frontier,
        'DROP TRIGGER IF EXISTS temp.__clinical_source_fingerprints_' + event,
      );
    execIntakeFrontierAuxiliarySQL(db, frontier, 'DROP TABLE IF EXISTS temp.' + TABLE);
    execIntakeFrontierAuxiliarySQL(db, frontier, 'DROP TABLE IF EXISTS temp.' + META);
    for (const sql of definition) execIntakeFrontierAuxiliarySQL(db, frontier, sql);
    execIntakeFrontierAuxiliarySQL(db, frontier, `INSERT INTO ${META} VALUES(1,0)`);
    const selectedDataVersion = dataVersion(db),
      selectedSchema = schema(db),
      selectedMainSchema = mainSchema(db),
      insert = prepareIntakeFrontierAuxiliaryInsert(
        db,
        frontier,
        `INSERT INTO ${TABLE}(record_id,provider_id,digest) VALUES(?,?,?)`,
      );
    let rows = 0;
    const assertCurrent = () => {
      options.assertRunning?.();
      if (
        dataVersion(db) !== selectedDataVersion ||
        schema(db) !== selectedSchema ||
        mainSchema(db) !== selectedMainSchema ||
        Number(db.prepare(`SELECT generation FROM ${META} WHERE singleton=1`).get()?.generation) !==
          0
      )
        throw unavailable();
    };
    for (const row of db
      .prepare(
        "SELECT id,provider_id,raw_json FROM source_records WHERE kind LIKE 'intake_%' ORDER BY id",
      )
      .iterate()) {
      runIntakeFrontierAuxiliaryInsert(db, frontier, insert, [
        row.id as string,
        row.provider_id as string | null,
        canonicalDigest(db, row.raw_json, 'reconstruction'),
      ]);
      if (++rows % 64 === 0) {
        await setImmediate();
        assertCurrent();
      }
    }
    assertCurrent();
    state.dataVersion = selectedDataVersion;
    state.schema = selectedSchema;
    state.mainSchema = selectedMainSchema;
    state.ready = true;
    complete = true;
  } catch (error) {
    state.ready = false;
    throw error;
  } finally {
    finishIntakeFrontierAuxiliaryPreparation(db, frontier, complete);
  }
}
/** Selected canonical strings are bounded changed JSONL inputs, never prior provider history. */
export function matchingClinicalSourceCanonicals(
  db: DatabaseSync,
  providerId: unknown,
  canonicals: Iterable<string>,
): Set<string> {
  checked(db);
  const result = new Set<string>(),
    lookup = db.prepare(`SELECT 1 FROM ${TABLE} WHERE provider_id=? AND digest=? LIMIT 1`);
  for (const canonical of canonicals) {
    withIntakeWork(db, 'warm', () => recordIntakeWork('clinicalCanonicalIndexLookups'));
    const digest = createHash('sha256').update(canonical).digest('hex');
    if (
      lookup.get(
        providerId === null || providerId === undefined ? null : String(providerId),
        digest,
      )
    )
      result.add(canonical);
  }
  return result;
}
/** Call on cache/session invalidation; a later read must explicitly rebuild complete state. */
export function invalidateClinicalSourceFingerprintIndex(db: DatabaseSync): void {
  const state = states.get(db);
  if (state) state.ready = false;
}
