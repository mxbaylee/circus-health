/** Disposable invalidation only. Fresh review/acceptance still verifies durable authority. */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
const table = '__intake_clinical_cache_pin';
const tracked = [
  'providers',
  'people',
  'notes',
  'manual_batches',
  'source_records',
  'record_relationships',
  'reports',
  'test_types',
  'observations',
  'medications',
  'procedures',
  'documents',
  'evidence',
  'visibility_events',
  'assets',
  'attachments',
  'note_links',
  'conditions',
  'medication_preferences',
] as const;
const initialized = new WeakMap<DatabaseSync, string>();
export function intakeClinicalCachePin(db: DatabaseSync): string {
  let generation = initialized.get(db);
  if (
    !generation ||
    !db.prepare("SELECT 1 FROM sqlite_temp_master WHERE type='table' AND name=?").get(table)
  ) {
    generation = randomUUID();
    db.exec(
      `CREATE TEMP TABLE IF NOT EXISTS ${table}(id INTEGER PRIMARY KEY,value INTEGER);INSERT OR IGNORE INTO ${table} VALUES(1,0);`,
    );
    for (const name of tracked) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))
        continue;
      for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
        const relevant = (row: string) =>
          `${row}.title IN ('Import mapping decision','Import record exception','Duplicate evidence decision','Report ownership default','Record ownership correction','Record ownership event')`;
        const when =
          name === 'manual_batches'
            ? ' WHEN ' +
              (event === 'UPDATE'
                ? `(${relevant('OLD')} OR ${relevant('NEW')})`
                : relevant(event === 'DELETE' ? 'OLD' : 'NEW'))
            : '';
        db.exec(
          `CREATE TEMP TRIGGER IF NOT EXISTS ${table}_${name}_${event} AFTER ${event} ON main.${name}${when} BEGIN UPDATE ${table} SET value=value+1 WHERE id=1; END`,
        );
      }
    }
    // Workflow JSON and source-text bookkeeping have their own exact per-source pins.
    db.exec(
      `CREATE TEMP TRIGGER IF NOT EXISTS ${table}_source_identity AFTER UPDATE OF provider_id,path,sha256,bytes,kind ON main.source_files WHEN OLD.provider_id IS NOT NEW.provider_id OR OLD.path IS NOT NEW.path OR OLD.sha256 IS NOT NEW.sha256 OR OLD.bytes IS NOT NEW.bytes OR OLD.kind IS NOT NEW.kind BEGIN UPDATE ${table} SET value=value+1 WHERE id=1; END`,
    );
    for (const event of ['INSERT', 'DELETE'])
      db.exec(
        `CREATE TEMP TRIGGER IF NOT EXISTS ${table}_source_${event} AFTER ${event} ON main.source_files${event === 'INSERT' ? " WHEN NEW.kind<>'intake_proposal' OR EXISTS(SELECT 1 FROM source_records WHERE source_file_id=NEW.id)" : ''} BEGIN UPDATE ${table} SET value=value+1 WHERE id=1; END`,
      );
    for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
      const row = event === 'DELETE' ? 'OLD' : 'NEW';
      db.exec(
        `CREATE TEMP TRIGGER IF NOT EXISTS ${table}_owner_${event} AFTER ${event} ON main.app_meta WHEN ${row}.key='owner_profile_id' BEGIN UPDATE ${table} SET value=value+1 WHERE id=1; END`,
      );
    }
    initialized.set(db, generation);
  }
  return (
    generation +
    ':' +
    String(db.prepare(`SELECT value FROM ${table} WHERE id=1`).get()!.value) +
    ':' +
    String(db.prepare('PRAGMA data_version').get()!.data_version)
  );
}
