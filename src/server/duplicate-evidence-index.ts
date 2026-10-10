/** Complete disposable saved-evidence digests; accepted rows remain authority. */
import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import {
  HttpError,
  managedDatabaseFunctionSetter,
  observeManagedDatabaseFunctionRegistration,
  type Database,
} from './database.ts';
import {
  beginIntakeFrontierAuxiliaryPreparation,
  execIntakeFrontierAuxiliarySQL,
  finishIntakeFrontierAuxiliaryPreparation,
} from './intake-lookup-frontier-observer.ts';
import {
  duplicateEvidenceValue,
  duplicateRecordHeader,
  rawSavedEvidenceValues,
} from './duplicate-review.ts';
import { canonicalLiteral } from './intake-format.ts';
import { withIntakeWork, recordIntakeWork } from './intake-work-accounting.ts';
import type {
  SavedDuplicateEvidenceReference,
  SavedDuplicateEvidencePage,
} from '../shared/saved-duplicate-evidence.ts';

const TABLE = '__duplicate_evidence_cache',
  META = '__duplicate_evidence_meta',
  ORIGINALS = '__duplicate_evidence_originals';
const kinds = "('observation','medication','procedure','document')";
const joined =
  'SELECT s.*,e.id AS evidence_id,e.locator_json AS evidence_locator,p.name AS acquiring_source FROM evidence e JOIN source_records s ON s.id=e.source_record_id LEFT JOIN providers p ON p.id=s.provider_id';
const dirty = (select: string) =>
  `INSERT OR IGNORE INTO ${TABLE}(kind,id,dirty) SELECT *,1 FROM (${select}); UPDATE ${TABLE} SET dirty=1 WHERE (kind,id) IN (${select}); UPDATE ${META} SET generation=generation+1;`;
const tables = ['evidence', 'source_records', 'source_files', 'providers'];
const version = (db: Database) => Number(db.prepare('PRAGMA data_version').get()!.data_version);
const schema = (db: Database) =>
  JSON.stringify(
    db
      .prepare(
        "SELECT name,sql FROM sqlite_temp_schema WHERE name LIKE '__duplicate_evidence_%' ORDER BY name",
      )
      .all(),
  );
const mainSchema = (db: Database) =>
  JSON.stringify(
    db
      .prepare(
        "SELECT name,sql FROM sqlite_schema WHERE name IN ('evidence','source_records','source_files','providers') ORDER BY name",
      )
      .all(),
  );
const pending = () =>
  new HttpError(
    409,
    'DUPLICATE_EVIDENCE_PENDING',
    'Prepare complete saved evidence before reviewing this pair',
  );
interface State {
  ready: boolean;
  schema: string;
  main: string;
  version: number;
  rows: number;
  coldRows: number;
  maxValueBytes: number;
}
const states = new WeakMap<Database, State>();
const functions = new WeakMap<Database, { current: boolean; setter: Database['function'] }>();
/** Only registers the fixed function; cold evidence reconstruction remains separately awaited. */
export function ensureDuplicateEvidenceFunction(db: Database): void {
  let binding = functions.get(db);
  if (binding?.current && binding.setter === db.function) return;
  if (db.function !== managedDatabaseFunctionSetter(db)) throw pending();
  if (!binding) {
    binding = { current: false, setter: db.function };
    functions.set(db, binding);
    const selected = binding;
    observeManagedDatabaseFunctionRegistration(db, (name) => {
      if (name.toLowerCase() !== 'circus_duplicate_original_id') return;
      selected.current = false;
      const state = states.get(db);
      if (state) state.ready = false;
    });
  }
  db.function('circus_duplicate_original_id', { deterministic: true }, (locator, fallback) => {
    try {
      const value = JSON.parse(String(locator)) as { originalSourceFileId?: unknown };
      return typeof value?.originalSourceFileId === 'string' && value.originalSourceFileId
        ? value.originalSourceFileId
        : String(fallback);
    } catch {
      return String(fallback);
    }
  });
  binding.current = true;
}
function checked(db: Database) {
  const state = states.get(db);
  if (
    !state?.ready ||
    !functions.get(db)?.current ||
    functions.get(db)?.setter !== db.function ||
    state.schema !== schema(db) ||
    state.main !== mainSchema(db) ||
    state.version !== version(db)
  ) {
    if (state) state.ready = false;
    throw pending();
  }
  return state;
}
function initialize(db: Database): State {
  const frontier = beginIntakeFrontierAuxiliaryPreparation(db, 'duplicate-evidence');
  let complete = false;
  const exec = (sql: string) => execIntakeFrontierAuxiliarySQL(db, frontier, sql);
  try {
    for (const table of tables)
      for (const action of ['insert', 'update', 'delete'])
        exec(`DROP TRIGGER IF EXISTS temp.__duplicate_evidence_${table}_${action}`);
    exec(`DROP TABLE IF EXISTS temp.${TABLE}; DROP TABLE IF EXISTS temp.${META}; DROP TABLE IF EXISTS temp.${ORIGINALS};
    CREATE TEMP TABLE ${TABLE}(kind TEXT,id TEXT,dirty INTEGER NOT NULL,count INTEGER,digest TEXT,scope_digest TEXT,raw_digest TEXT,error TEXT,PRIMARY KEY(kind,id));
    CREATE TEMP TABLE ${ORIGINALS}(kind TEXT,id TEXT,url TEXT,PRIMARY KEY(kind,id,url));
    CREATE TEMP TABLE ${META}(generation INTEGER NOT NULL); INSERT INTO ${META} VALUES(0);`);
    for (const action of ['insert', 'update', 'delete']) {
      const aliases = action === 'update' ? ['OLD', 'NEW'] : [action === 'delete' ? 'OLD' : 'NEW'];
      const create = (table: string, sql: string, when = '') =>
        exec(
          `CREATE TEMP TRIGGER __duplicate_evidence_${table}_${action} AFTER ${action} ON main.${table} ${when} BEGIN ${sql} END`,
        );
      create(
        'evidence',
        aliases
          .map((a) =>
            dirty(`SELECT ${a}.entity_type,${a}.entity_id WHERE ${a}.entity_type IN ${kinds}`),
          )
          .join(' '),
      );
      create(
        'source_records',
        aliases
          .map((a) =>
            dirty(
              `SELECT e.entity_type,e.entity_id FROM evidence e WHERE e.source_record_id=${a}.id AND e.entity_type IN ${kinds}`,
            ),
          )
          .join(' '),
      );
      create(
        'providers',
        aliases
          .map((a) =>
            dirty(
              `SELECT e.entity_type,e.entity_id FROM evidence e JOIN source_records s ON s.id=e.source_record_id WHERE s.provider_id=${a}.id AND e.entity_type IN ${kinds}`,
            ),
          )
          .join(' '),
        action === 'update' ? 'WHEN OLD.name IS NOT NEW.name OR OLD.id IS NOT NEW.id' : '',
      );
      create(
        'source_files',
        aliases
          .map((a) =>
            dirty(
              `SELECT e.entity_type,e.entity_id FROM evidence e JOIN source_records s ON s.id=e.source_record_id WHERE (s.source_file_id=${a}.id OR json_extract(e.locator_json,'$.originalSourceFileId')=${a}.id OR circus_duplicate_original_id(e.locator_json,s.source_file_id)=${a}.id) AND e.entity_type IN ${kinds}`,
            ),
          )
          .join(' '),
        action === 'update'
          ? 'WHEN OLD.id IS NOT NEW.id OR OLD.sha256 IS NOT NEW.sha256 OR OLD.bytes IS NOT NEW.bytes'
          : '',
      );
    }
    exec(
      `INSERT OR IGNORE INTO ${TABLE}(kind,id,dirty) SELECT entity_type,entity_id,1 FROM evidence WHERE entity_type IN ${kinds}`,
    );
    const state = {
      ready: true,
      schema: schema(db),
      main: mainSchema(db),
      version: version(db),
      rows: 0,
      coldRows: 0,
      maxValueBytes: 0,
    };
    states.set(db, state);
    complete = true;
    return state;
  } finally {
    finishIntakeFrontierAuxiliaryPreparation(db, frontier, complete);
  }
}
function scoped(db: Database, evidence: ReturnType<typeof duplicateEvidenceValue>) {
  const match = /^\/api\/sources\/([^/?#]+)\/content(?:[?#]|$)/.exec(evidence.contentUrl);
  let source: unknown = null;
  if (match) {
    try {
      source =
        db
          .prepare('SELECT id,sha256,bytes FROM source_files WHERE id=?')
          .get(decodeURIComponent(match[1]!)) || null;
    } catch {
      throw new HttpError(409, 'DUPLICATE_EVIDENCE', 'The exact original reference is unavailable');
    }
    if (!source)
      throw new HttpError(409, 'DUPLICATE_EVIDENCE', 'The exact original reference is unavailable');
  }
  return { evidence, source };
}
/** A cold installation scans each saved target once. Warm work hashes only targets dirtied by changed dependencies. */
export async function prepareDuplicateEvidenceIndex(
  db: Database,
  options: { assertRunning?: () => void } = {},
) {
  if (db.isTransaction) throw Error('Prepare saved evidence outside the application transaction');
  ensureDuplicateEvidenceFunction(db);
  let state: State,
    cold = false;
  try {
    state = checked(db);
  } catch (error) {
    if (!(error instanceof HttpError && error.code === 'DUPLICATE_EVIDENCE_PENDING')) throw error;
    state = initialize(db);
    cold = true;
  }
  const generation = Number(db.prepare(`SELECT generation FROM ${META}`).get()!.generation);
  const phase = cold ? 'reconstruction' : 'warm';
  const yieldStep = async () => {
    withIntakeWork(db, phase, () => recordIntakeWork('duplicateEvidenceYields'));
    await setImmediate();
    current();
  };
  const current = () => {
    options.assertRunning?.();
    checked(db);
    if (Number(db.prepare(`SELECT generation FROM ${META}`).get()!.generation) !== generation)
      throw pending();
  };
  for (const target of db
    .prepare(`SELECT kind,id FROM ${TABLE} WHERE dirty=1 ORDER BY kind,id`)
    .iterate()) {
    current();
    try {
      const hash = createHash('sha256').update('['),
        scope = createHash('sha256').update('[');
      db.prepare(`DELETE FROM ${ORIGINALS} WHERE kind=? AND id=?`).run(target.kind!, target.id!);
      let count = 0;
      for (const row of db
        .prepare(joined + ' WHERE e.entity_type=? AND e.entity_id=? ORDER BY e.id')
        .iterate(target.kind!, target.id!)) {
        const value = duplicateEvidenceValue(row),
          text = canonicalLiteral(value),
          scopeText = canonicalLiteral(scoped(db, value));
        db.prepare(`INSERT OR IGNORE INTO ${ORIGINALS} VALUES(?,?,?)`).run(
          target.kind!,
          target.id!,
          value.contentUrl,
        );
        if (count++) {
          hash.update(',');
          scope.update(',');
        }
        hash.update(text);
        scope.update(scopeText);
        state.rows++;
        withIntakeWork(db, phase, () => {
          recordIntakeWork('duplicateEvidenceHashedRows');
          recordIntakeWork(
            'duplicateEvidenceHashedBytes',
            Buffer.byteLength(text) + Buffer.byteLength(scopeText),
          );
        });
        if (cold) state.coldRows++;
        state.maxValueBytes = Math.max(
          state.maxValueBytes,
          Buffer.byteLength(text),
          Buffer.byteLength(scopeText),
        );
        if (count % 32 === 0) {
          await yieldStep();
        }
      }
      const raw = createHash('sha256').update('[');
      let rawCount = 0;
      for (const value of rawSavedEvidenceValues(
        db,
        String(target.kind) as SavedDuplicateEvidenceReference['kind'],
        String(target.id),
      )) {
        if (rawCount++) raw.update(',');
        const text = canonicalLiteral(value);
        raw.update(text);
        withIntakeWork(db, phase, () => {
          recordIntakeWork('duplicateEvidenceRawHashedRows');
          recordIntakeWork('duplicateEvidenceHashedBytes', Buffer.byteLength(text));
        });
        if (rawCount % 32 === 0) {
          await yieldStep();
        }
      }
      current();
      db.prepare(
        `UPDATE ${TABLE} SET dirty=0,error=NULL,count=?,digest=?,scope_digest=?,raw_digest=? WHERE kind=? AND id=?`,
      ).run(
        count,
        hash.update(']').digest('hex'),
        scope.update(']').digest('hex'),
        raw.update(']').digest('hex'),
        target.kind!,
        target.id!,
      );
    } catch (error) {
      current();
      if (!(error instanceof HttpError && error.code === 'DUPLICATE_EVIDENCE')) throw error;
      // A damaged unrelated target is not an absence answer and does not block
      // another intake's selected evidence. Selecting it still refuses exactly.
      db.prepare(`UPDATE ${TABLE} SET dirty=0,error=? WHERE kind=? AND id=?`).run(
        error.message,
        target.kind!,
        target.id!,
      );
    }
    await yieldStep();
  }
}
const empty = createHash('sha256').update('[]').digest('hex');
export function selectedDuplicateEvidenceDigest(db: Database, kind: string, id: string) {
  checked(db);
  const row = db
    .prepare(
      `SELECT dirty,count,digest,scope_digest,raw_digest,error FROM ${TABLE} WHERE kind=? AND id=?`,
    )
    .get(kind, id);
  if (row?.dirty) throw pending();
  if (row?.error) throw new HttpError(409, 'DUPLICATE_EVIDENCE', String(row.error));
  if (!row) {
    if (
      db.prepare('SELECT 1 FROM evidence WHERE entity_type=? AND entity_id=? LIMIT 1').get(kind, id)
    )
      throw pending();
    return { count: 0, digest: empty, scopeDigest: empty, rawDigest: empty };
  }
  return {
    count: Number(row.count),
    digest: String(row.digest),
    scopeDigest: String(row.scope_digest),
    rawDigest: String(row.raw_digest),
  };
}
export function savedDuplicateEvidenceReference(
  db: Database,
  kind: string,
  id: string,
): SavedDuplicateEvidenceReference {
  const header = duplicateRecordHeader(db, kind, id),
    digest = selectedDuplicateEvidenceDigest(db, kind, id);
  const params = new URLSearchParams({
    kind: header.kind,
    recordId: id,
    stateHash: header.stateHash,
    digest: digest.digest,
    scopeDigest: digest.scopeDigest,
  });
  return {
    format: 'health-saved-evidence-v1',
    kind: header.kind,
    recordId: id,
    count: digest.count,
    digest: digest.digest,
    scopeDigest: digest.scopeDigest,
    stateHash: header.stateHash,
    url: '/api/clinical-review/saved-evidence?' + params,
  };
}
/** A display cue only: preserve the legacy exact original URL equality test. */
export function savedDuplicateOriginalOverlap(
  db: Database,
  kind: string,
  id: string,
  incoming: Iterable<{ contentUrl?: string }>,
): boolean {
  selectedDuplicateEvidenceDigest(db, kind, id);
  for (const evidence of incoming)
    if (
      evidence.contentUrl &&
      db
        .prepare(`SELECT 1 FROM ${ORIGINALS} WHERE kind=? AND id=? AND url=?`)
        .get(kind, id, evidence.contentUrl)
    )
      return true;
  return false;
}
export function readSavedDuplicateEvidence(db: Database, params: URLSearchParams) {
  const kind = params.get('kind') || '',
    id = params.get('recordId') || '';
  if (!id || id.length > 2000)
    throw new HttpError(400, 'DUPLICATE_EVIDENCE', 'Choose a saved record');
  const reference = savedDuplicateEvidenceReference(db, kind, id);
  if (
    reference.digest !== params.get('digest') ||
    reference.scopeDigest !== params.get('scopeDigest') ||
    reference.stateHash !== params.get('stateHash')
  )
    throw new HttpError(409, 'DUPLICATE_EVIDENCE_CHANGED', 'Refresh this exact saved evidence');
  const item = params.get('item');
  if (item) {
    if (item.length > 2000)
      throw new HttpError(400, 'DUPLICATE_EVIDENCE', 'Choose one evidence row');
    const row = db
      .prepare(joined + ' WHERE e.entity_type=? AND e.entity_id=? AND e.id=?')
      .get(kind, id, item);
    if (!row) throw new HttpError(404, 'DUPLICATE_EVIDENCE', 'Evidence row not found');
    const data = Buffer.from(canonicalLiteral(duplicateEvidenceValue(row))),
      offset = Number(params.get('offset') || 0);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > data.length)
      throw new HttpError(400, 'DUPLICATE_EVIDENCE', 'Invalid fragment offset');
    const end = Math.min(offset + 32768, data.length);
    return {
      encoding: 'base64',
      data: data.subarray(offset, end).toString('base64'),
      complete: end === data.length,
      nextOffset: end === data.length ? null : end,
    };
  }
  const after = params.get('after') || '';
  if (after.length > 2000)
    throw new HttpError(400, 'DUPLICATE_EVIDENCE', 'Invalid evidence cursor');
  const page: SavedDuplicateEvidencePage = { reference, items: [], complete: true, after: null };
  for (const row of db
    .prepare(joined + ' WHERE e.entity_type=? AND e.entity_id=? AND e.id>? ORDER BY e.id LIMIT 17')
    .iterate(kind, id, after)) {
    if (page.items.length >= 16) {
      page.complete = false;
      break;
    }
    const value = duplicateEvidenceValue(row),
      size = Buffer.byteLength(canonicalLiteral(value)),
      evidenceId = String(row.evidence_id);
    const entry =
      size > 32768
        ? {
            kind: 'fragment' as const,
            id: evidenceId,
            bytes: size,
            url: reference.url + '&item=' + encodeURIComponent(evidenceId),
          }
        : { kind: 'value' as const, id: evidenceId, value };
    // Count the actual wire representation, including reference, IDs and
    // continuation metadata, rather than assuming a fragment header size.
    const responseBytes = Buffer.byteLength(
      JSON.stringify({
        ...page,
        items: [...page.items, entry],
        complete: false,
        after: evidenceId,
      }),
    );
    if (responseBytes > 65536) {
      if (!page.items.length)
        throw new HttpError(
          409,
          'DUPLICATE_EVIDENCE',
          'This evidence reference exceeds one review window',
        );
      page.complete = false;
      break;
    }
    page.items.push(entry);
  }
  page.after = page.complete ? null : page.items.at(-1)!.id;
  return page;
}
export function duplicateEvidenceIndexWork(db: Database) {
  const state = checked(db);
  return { rows: state.rows, coldRows: state.coldRows, maxValueBytes: state.maxValueBytes };
}
