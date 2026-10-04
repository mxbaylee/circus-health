/** Disposable changed-source attention counts; originals and revision metadata remain authority. */
import { setImmediate } from 'node:timers/promises';
import { HttpError, revision, type Database } from './database.ts';
import { visibilityCondition, visibilitySQL } from './visibility.ts';
import { recordIntakeWork, withIntakeWork } from './intake-work-accounting.ts';
import type { SourceAttentionQueue } from '../shared/intake-source-text.ts';

const rows = 'source_attention_counts_v1',
  dirty = 'source_attention_dirty_v1',
  state = 'source_attention_state_v1';
const prefix = 'intake_source_text:v1:';
function affected(key: string) {
  return `CASE
    WHEN ${key} GLOB '${prefix}*:head' THEN substr(${key},${prefix.length + 1},length(${key})-${prefix.length + 5})
    WHEN ${key} GLOB '${prefix}*:revision:*' THEN substr(${key},${prefix.length + 1},length(${key})-${prefix.length + 46})
    WHEN ${key} GLOB '${prefix}*:blob:*' THEN substr(${key},${prefix.length + 1},length(${key})-${prefix.length + 70})
    END`;
}
function prepareTables(db: Database) {
  const complete =
    Number(
      db
        .prepare(
          "SELECT COUNT(*) n FROM temp.sqlite_master WHERE (type='table' AND name IN ('source_attention_counts_v1','source_attention_dirty_v1','source_attention_state_v1')) OR (type='trigger' AND name IN ('source_attention_files_insert','source_attention_files_update','source_attention_files_delete','source_attention_meta_insert','source_attention_meta_update','source_attention_meta_delete'))",
        )
        .get()!.n,
    ) === 9;
  db.exec(`CREATE TEMP TABLE IF NOT EXISTS ${rows}(source_id TEXT PRIMARY KEY,sections INTEGER NOT NULL);
    CREATE TEMP TABLE IF NOT EXISTS ${dirty}(source_id TEXT PRIMARY KEY);
    CREATE TEMP TABLE IF NOT EXISTS ${state}(singleton INTEGER PRIMARY KEY,profile_id TEXT NOT NULL,data_version INTEGER NOT NULL);`);
  if (!complete) db.exec(`DELETE FROM temp.${state}`);
  for (const action of ['INSERT', 'UPDATE', 'DELETE']) {
    const versions = action === 'UPDATE' ? ['old', 'new'] : [action === 'DELETE' ? 'old' : 'new'];
    db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS source_attention_files_${action.toLowerCase()} AFTER ${action} ON main.source_files BEGIN
      ${versions.map((v) => `INSERT INTO ${dirty} SELECT ${v}.id WHERE NOT EXISTS(SELECT 1 FROM ${dirty} WHERE source_id=${v}.id);`).join('\n')}
      END;`);
    db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS source_attention_meta_${action.toLowerCase()} AFTER ${action} ON main.app_meta BEGIN
      ${versions.map((v) => `INSERT INTO ${dirty} SELECT ${affected(v + '.key')} WHERE ${affected(v + '.key')} IS NOT NULL AND NOT EXISTS(SELECT 1 FROM ${dirty} WHERE source_id=${affected(v + '.key')});`).join('\n')}
      END;`);
  }
}
export async function readPreparedSourceAttention(
  db: Database,
  profileId: string,
  offset: number,
  sectionsFor: (file: { id: string; sha256: string }) => number,
): Promise<SourceAttentionQueue> {
  const owner = () => {
    if (
      db.prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'").get()?.value !==
      profileId
    )
      throw new HttpError(403, 'PROFILE_SCOPE', 'Source text belongs to a different profile');
  };
  owner();
  prepareTables(db);
  const dataVersion = () => Number(db.prepare('PRAGMA data_version').get()!.data_version),
    selectedDataVersion = dataVersion(),
    selectedRevision = revision(db);
  const assertCurrent = () => {
    owner();
    if (revision(db) !== selectedRevision || dataVersion() !== selectedDataVersion)
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
    db.exec(`DELETE FROM temp.${rows}; DELETE FROM temp.${dirty};
      INSERT INTO temp.${dirty} SELECT id FROM source_files WHERE kind='intake_original';`);
    db.prepare(`INSERT OR REPLACE INTO temp.${state} VALUES(1,?,?)`).run(
      profileId,
      selectedDataVersion,
    );
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
      db.prepare(
        `INSERT INTO temp.${rows} VALUES(?,?) ON CONFLICT(source_id) DO UPDATE SET sections=excluded.sections`,
      ).run(id, sections);
    } else db.prepare(`DELETE FROM temp.${rows} WHERE source_id=?`).run(id);
    db.prepare(`DELETE FROM temp.${dirty} WHERE source_id=?`).run(id);
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
