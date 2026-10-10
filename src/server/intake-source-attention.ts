/** Disposable changed-source attention counts; originals and revision metadata remain authority. */
import { setImmediate } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:sqlite';
import {
  assertClinicalOperation,
  currentClinicalOperation,
  runExclusiveClinicalOperation,
} from './clinical-operation.ts';
import {
  execClinicalReviewMaintenance,
  prepareClinicalReviewMaintenance,
  registerAttentionMaintenanceObserver,
} from './clinical-review-maintenance.ts';
import {
  HttpError,
  revision,
  managedDatabaseAuthorizerSetter,
  managedDatabaseFunctionSetter,
  observeManagedDatabaseAuthorization,
  observeManagedDatabaseFunctionRegistration,
  type Database,
} from './database.ts';
import { visibilityCondition, visibilitySQL } from './visibility.ts';
import { recordIntakeWork, withIntakeWork } from './intake-work-accounting.ts';
import type { SourceAttentionQueue } from '../shared/intake-source-text.ts';

const rows = 'source_attention_counts_v1',
  dirty = 'source_attention_dirty_v1',
  state = 'source_attention_state_v1';
const prefix = 'intake_source_text:v1:';
interface AttentionGuard {
  owned: number;
  invalid: boolean;
  readonly functionName: string;
  readonly triggerNames: string[];
  readonly functionSetter: Database['function'];
  readonly authorizer: Database['setAuthorizer'];
}
const guards = new WeakMap<Database, AttentionGuard>();
const schemaActions = new Set([
  constants.SQLITE_CREATE_INDEX,
  constants.SQLITE_CREATE_TABLE,
  constants.SQLITE_CREATE_TEMP_INDEX,
  constants.SQLITE_CREATE_TEMP_TABLE,
  constants.SQLITE_CREATE_TEMP_TRIGGER,
  constants.SQLITE_CREATE_TEMP_VIEW,
  constants.SQLITE_CREATE_TRIGGER,
  constants.SQLITE_CREATE_VIEW,
  constants.SQLITE_CREATE_VTABLE,
  constants.SQLITE_DROP_INDEX,
  constants.SQLITE_DROP_TABLE,
  constants.SQLITE_DROP_TEMP_INDEX,
  constants.SQLITE_DROP_TEMP_TABLE,
  constants.SQLITE_DROP_TEMP_TRIGGER,
  constants.SQLITE_DROP_TEMP_VIEW,
  constants.SQLITE_DROP_TRIGGER,
  constants.SQLITE_DROP_VIEW,
  constants.SQLITE_DROP_VTABLE,
  constants.SQLITE_ALTER_TABLE,
  constants.SQLITE_ATTACH,
  constants.SQLITE_DETACH,
]);
function attentionGuard(db: Database) {
  const old = guards.get(db);
  if (old) {
    if (db.function !== old.functionSetter)
      throw Error('Source attention database function registration was replaced');
    if (db.setAuthorizer !== old.authorizer)
      throw Error('Source attention database authorizer was replaced');
    return old;
  }
  const authorizer = managedDatabaseAuthorizerSetter(db),
    functionSetter = managedDatabaseFunctionSetter(db);
  if (
    !authorizer ||
    !functionSetter ||
    db.setAuthorizer !== authorizer ||
    db.function !== functionSetter
  )
    throw Error('Source attention requires managed database authorization');
  const functionName = '__source_attention_event_' + randomUUID().replaceAll('-', '');
  const guard: AttentionGuard = {
    owned: 0,
    invalid: true,
    functionName,
    triggerNames: [],
    functionSetter,
    authorizer,
  };
  guards.set(db, guard);
  if (
    !observeManagedDatabaseFunctionRegistration(db, (name) => {
      if (name === functionName && !guard.owned) guard.invalid = true;
    })
  )
    throw Error('Source attention function observation is unavailable');
  const observed = observeManagedDatabaseAuthorization(
    db,
    (action, _arg1, detail, _database, origin) => {
      if (
        !guard.owned &&
        (schemaActions.has(action) || (action === constants.SQLITE_PRAGMA && detail !== null))
      )
        guard.invalid = true;
      if (
        action === constants.SQLITE_FUNCTION &&
        detail === functionName &&
        !guard.triggerNames.includes(origin ?? '')
      )
        guard.invalid = true;
    },
    () => {
      if (!guard.owned) guard.invalid = true;
    },
  );
  if (!observed) throw Error('Source attention authorization observation is unavailable');
  return guard;
}
function owned<T>(guard: AttentionGuard, work: () => T): T {
  guard.owned++;
  try {
    return work();
  } finally {
    guard.owned--;
  }
}
function installGuardTriggers(db: Database, guard: AttentionGuard) {
  guard.functionSetter.call(db, guard.functionName, () => {
    if (!guard.owned) guard.invalid = true;
    return null;
  });
  const statements: Array<{ name: string; sql: string }> = [];
  for (const table of [rows, dirty, state])
    for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
      // An extra dirty source only adds conservative work; deletion can hide it.
      if (table === dirty && operation === 'INSERT') continue;
      const name = `${guard.functionName}_${table}_${operation.toLowerCase()}`;
      statements.push({
        name,
        sql: `CREATE TEMP TRIGGER ${name} AFTER ${operation} ON temp.${table} BEGIN SELECT ${guard.functionName}(); END`,
      });
    }
  registerAttentionMaintenanceObserver(
    db,
    guard.functionName,
    statements.map((statement) => statement.name),
  );
  for (const name of guard.triggerNames)
    execClinicalReviewMaintenance(db, 'attention', `DROP TRIGGER IF EXISTS temp.${name}`);
  guard.triggerNames.length = 0;
  for (const statement of statements) {
    guard.triggerNames.push(statement.name);
    execClinicalReviewMaintenance(db, 'attention', statement.sql);
  }
}
function affected(key: string) {
  return `CASE
    WHEN ${key} GLOB '${prefix}*:head' THEN substr(${key},${prefix.length + 1},length(${key})-${prefix.length + 5})
    WHEN ${key} GLOB '${prefix}*:revision:*' THEN substr(${key},${prefix.length + 1},length(${key})-${prefix.length + 46})
    WHEN ${key} GLOB '${prefix}*:blob:*' THEN substr(${key},${prefix.length + 1},length(${key})-${prefix.length + 70})
    END`;
}
function prepareTables(db: Database, resetTriggers = false) {
  const complete =
    Number(
      db
        .prepare(
          "SELECT COUNT(*) n FROM temp.sqlite_master WHERE (type='table' AND name IN ('source_attention_counts_v1','source_attention_dirty_v1','source_attention_state_v1')) OR (type='trigger' AND name IN ('source_attention_files_insert','source_attention_files_update','source_attention_files_delete','source_attention_meta_insert','source_attention_meta_update','source_attention_meta_delete'))",
        )
        .get()!.n,
    ) === 9;
  for (const sql of [
    `CREATE TEMP TABLE IF NOT EXISTS ${rows}(source_id TEXT PRIMARY KEY,sections INTEGER NOT NULL)`,
    `CREATE TEMP TABLE IF NOT EXISTS ${dirty}(source_id TEXT PRIMARY KEY)`,
    `CREATE TEMP TABLE IF NOT EXISTS ${state}(singleton INTEGER PRIMARY KEY,profile_id TEXT NOT NULL,data_version INTEGER NOT NULL)`,
  ])
    execClinicalReviewMaintenance(db, 'attention', sql);
  if (!complete) execClinicalReviewMaintenance(db, 'attention', `DELETE FROM temp.${state}`);
  if (resetTriggers)
    for (const kind of ['files', 'meta'])
      for (const action of ['insert', 'update', 'delete'])
        execClinicalReviewMaintenance(
          db,
          'attention',
          `DROP TRIGGER IF EXISTS temp.source_attention_${kind}_${action}`,
        );
  for (const action of ['INSERT', 'UPDATE', 'DELETE']) {
    const versions = action === 'UPDATE' ? ['old', 'new'] : [action === 'DELETE' ? 'old' : 'new'];
    execClinicalReviewMaintenance(
      db,
      'attention',
      `CREATE TEMP TRIGGER IF NOT EXISTS source_attention_files_${action.toLowerCase()} AFTER ${action} ON main.source_files BEGIN
      ${versions.map((v) => `INSERT INTO ${dirty} SELECT ${v}.id WHERE NOT EXISTS(SELECT 1 FROM ${dirty} WHERE source_id=${v}.id);`).join('\n')}
      END;`,
    );
    execClinicalReviewMaintenance(
      db,
      'attention',
      `CREATE TEMP TRIGGER IF NOT EXISTS source_attention_meta_${action.toLowerCase()} AFTER ${action} ON main.app_meta BEGIN
      ${versions.map((v) => `INSERT INTO ${dirty} SELECT ${affected(v + '.key')} WHERE ${affected(v + '.key')} IS NOT NULL AND NOT EXISTS(SELECT 1 FROM ${dirty} WHERE source_id=${affected(v + '.key')});`).join('\n')}
      END;`,
    );
  }
}
export async function readPreparedSourceAttention(
  db: Database,
  profileId: string,
  offset: number,
  sectionsFor: (file: { id: string; sha256: string }) => number,
): Promise<SourceAttentionQueue> {
  return runExclusiveClinicalOperation(
    db,
    async (operation) =>
      readPreparedSourceAttentionOwned(db, profileId, offset, sectionsFor, () =>
        assertClinicalOperation(db, operation),
      ),
    { operation: currentClinicalOperation(db) },
  );
}

async function readPreparedSourceAttentionOwned(
  db: Database,
  profileId: string,
  offset: number,
  sectionsFor: (file: { id: string; sha256: string }) => number,
  assertRunning: () => void,
): Promise<SourceAttentionQueue> {
  const owner = () => {
    assertRunning();
    if (
      db
        .prepare(
          "SELECT 1 FROM temp.sqlite_schema WHERE name IN ('app_meta','source_files','visibility_events','schema_migrations') LIMIT 1",
        )
        .get()
    )
      throw new HttpError(409, 'SOURCE_TEXT_CHANGED', 'Source attention authority is shadowed');
    if (
      db.prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'").get()?.value !==
      profileId
    )
      throw new HttpError(403, 'PROFILE_SCOPE', 'Source text belongs to a different profile');
  };
  owner();
  const guard = attentionGuard(db),
    rebuild = guard.invalid;
  if (rebuild)
    owned(guard, () => {
      prepareTables(db, true);
      installGuardTriggers(db, guard);
      execClinicalReviewMaintenance(db, 'attention', `DELETE FROM temp.${state}`);
      guard.invalid = false;
    });
  const dataVersion = () => Number(db.prepare('PRAGMA data_version').get()!.data_version),
    selectedDataVersion = dataVersion(),
    selectedRevision = revision(db);
  const assertCurrent = () => {
    owner();
    if (
      guard.invalid ||
      db.function !== guard.functionSetter ||
      db.setAuthorizer !== guard.authorizer ||
      revision(db) !== selectedRevision ||
      dataVersion() !== selectedDataVersion
    )
      throw new HttpError(
        409,
        'SOURCE_TEXT_CHANGED',
        'Reload source attention after the source changed.',
      );
  };
  const selected = db
    .prepare(`SELECT profile_id,data_version FROM temp.${state} WHERE singleton=1`)
    .get();
  if (
    !selected ||
    selected.profile_id !== profileId ||
    selected.data_version !== selectedDataVersion
  ) {
    owned(guard, () => {
      execClinicalReviewMaintenance(db, 'attention', `DELETE FROM temp.${rows}`);
      execClinicalReviewMaintenance(db, 'attention', `DELETE FROM temp.${dirty}`);
      execClinicalReviewMaintenance(
        db,
        'attention',
        `INSERT INTO temp.${dirty} SELECT id FROM source_files WHERE kind='intake_original'`,
      );
      prepareClinicalReviewMaintenance(
        db,
        'attention',
        `INSERT OR REPLACE INTO temp.${state} VALUES(1,?,?)`,
      ).run(profileId, selectedDataVersion);
    });
  }
  let processed = 0;
  for (;;) {
    assertCurrent();
    const next = db.prepare(`SELECT source_id FROM temp.${dirty} ORDER BY source_id LIMIT 1`).get();
    if (!next) break;
    const id = String(next.source_id);
    const file = db
      .prepare("SELECT id,sha256 FROM source_files WHERE id=? AND kind='intake_original'")
      .get(id) as { id: string; sha256: string } | undefined;
    if (file) {
      const sections = sectionsFor(file);
      if (!Number.isSafeInteger(sections) || sections < 0)
        throw Error('Invalid source attention count');
      owned(guard, () =>
        prepareClinicalReviewMaintenance(
          db,
          'attention',
          `INSERT INTO temp.${rows} VALUES(?,?) ON CONFLICT(source_id) DO UPDATE SET sections=excluded.sections`,
        ).run(id, sections),
      );
    } else
      owned(guard, () =>
        prepareClinicalReviewMaintenance(
          db,
          'attention',
          `DELETE FROM temp.${rows} WHERE source_id=?`,
        ).run(id),
      );
    owned(guard, () =>
      prepareClinicalReviewMaintenance(
        db,
        'attention',
        `DELETE FROM temp.${dirty} WHERE source_id=?`,
      ).run(id),
    );
    withIntakeWork(db, 'warm', () => recordIntakeWork('sourceAttentionPreparedSources'));
    if (++processed % 32 === 0) await setImmediate();
  }
  assertCurrent();
  const where =
    ` FROM temp.${rows} a JOIN source_files f ON f.id=a.source_id WHERE a.sections>0 AND f.kind='intake_original' AND ` +
    visibilityCondition(
      new URLSearchParams({ visibility: 'visible' }),
      visibilitySQL("'source_file'", 'f.id'),
    );
  const totals = db
    .prepare('SELECT COUNT(*) total,COALESCE(SUM(a.sections),0) sections' + where)
    .get()!;
  const items = db
    .prepare(
      'SELECT f.id intakeId,a.sections' +
        where +
        " ORDER BY json_extract(f.details_json,'$.intake.createdAt') DESC,f.id LIMIT 30 OFFSET ?",
    )
    .all(offset)
    .map((row) => ({ intakeId: String(row.intakeId), sections: Number(row.sections) }));
  assertCurrent();
  withIntakeWork(db, 'warm', () =>
    recordIntakeWork('sourceAttentionReturnedSources', items.length),
  );
  return {
    sections: Number(totals.sections),
    total: Number(totals.total),
    items,
    offset,
    nextOffset: offset + items.length < Number(totals.total) ? offset + items.length : null,
  };
}
