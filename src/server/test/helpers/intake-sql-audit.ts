import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';

export const SQL_AUDIT_VERSION = 2;

/** Logical stored-value mutations. TEMP measurement rows are outside the audited inventory. */
export function installIntakeSqlAudit(db: DatabaseSync): void {
  const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
  const stateSchema = db.prepare('PRAGMA table_info("__record_state")').all();
  assert.deepEqual(
    stateSchema.map((column) => [column.name, column.type, column.pk]),
    [
      ['singleton', 'INTEGER', 1],
      ['profile_id', 'TEXT', 0],
      ['projection', 'INTEGER', 0],
      ['schema_version', 'INTEGER', 0],
      ['sequence', 'INTEGER', 0],
      ['head_json', 'TEXT', 0],
    ],
    'replacement accounting requires the canonical singleton record-state schema',
  );
  const stateSql = String(
    db.prepare("SELECT sql FROM sqlite_master WHERE name='__record_state'").get()!.sql,
  );
  assert.match(stateSql, /CHECK\s*\(\s*singleton\s*=\s*1\s*\)/i);
  const bytes = (columns: string[], prefix: string) =>
    columns
      .map((column) => `COALESCE(length(CAST(${prefix}.${quote(column)} AS BLOB)),0)`)
      .join('+');
  db.exec(
    'CREATE TEMP TABLE mutation_sql_writes(table_name TEXT PRIMARY KEY,inserts INTEGER,updates INTEGER,deletes INTEGER,new_value_bytes INTEGER,old_value_bytes INTEGER)',
  );
  for (const row of db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()) {
    const table = String(row.name),
      columns = db
        .prepare(`PRAGMA table_info(${quote(table)})`)
        .all()
        .map((column) => String(column.name));
    db.prepare('INSERT INTO mutation_sql_writes VALUES(?,0,0,0,0,0)').run(table);
    const literal = "'" + table.replaceAll("'", "''") + "'";
    for (const event of ['INSERT', 'UPDATE', 'DELETE'] as const) {
      const counter = { INSERT: 'inserts', UPDATE: 'updates', DELETE: 'deletes' }[event];
      db.exec(
        `CREATE TEMP TRIGGER ${quote('mutation_audit_' + table + '_' + event)} AFTER ${event} ON main.${quote(table)} BEGIN UPDATE mutation_sql_writes SET ${counter}=${counter}+1,new_value_bytes=new_value_bytes+${event === 'DELETE' ? '0' : bytes(columns, 'NEW')},old_value_bytes=old_value_bytes+${event === 'INSERT' ? '0' : bytes(columns, 'OLD')} WHERE table_name=${literal}; END`,
      );
    }
  }
  // SQLite REPLACE omits DELETE triggers when recursive_triggers=0. Retain only
  // the canonical singleton's current byte total. A recursive DELETE clears it;
  // a silent replacement leaves it available to count the displaced row. AFTER
  // triggers also distinguish ignored inserts and UPDATE-style upserts correctly.
  const stateColumns = stateSchema.map((column) => String(column.name));
  db.exec(`
    CREATE TEMP TABLE mutation_record_state_shadow(singleton INTEGER PRIMARY KEY CHECK(singleton=1),bytes INTEGER NOT NULL);
    INSERT INTO mutation_record_state_shadow SELECT singleton,${bytes(stateColumns, 's')} FROM main.__record_state AS s;
    CREATE TEMP TRIGGER mutation_record_state_insert AFTER INSERT ON main.__record_state BEGIN
      UPDATE mutation_sql_writes SET
        deletes=deletes+(SELECT count(*) FROM mutation_record_state_shadow WHERE singleton=NEW.singleton),
        old_value_bytes=old_value_bytes+COALESCE((SELECT bytes FROM mutation_record_state_shadow WHERE singleton=NEW.singleton),0)
        WHERE table_name='__record_state';
      INSERT INTO mutation_record_state_shadow VALUES(NEW.singleton,${bytes(stateColumns, 'NEW')})
        ON CONFLICT(singleton) DO UPDATE SET bytes=excluded.bytes;
    END;
    CREATE TEMP TRIGGER mutation_record_state_update AFTER UPDATE ON main.__record_state BEGIN
      UPDATE mutation_record_state_shadow SET bytes=${bytes(stateColumns, 'NEW')} WHERE singleton=NEW.singleton;
    END;
    CREATE TEMP TRIGGER mutation_record_state_delete AFTER DELETE ON main.__record_state BEGIN
      DELETE FROM mutation_record_state_shadow WHERE singleton=OLD.singleton;
    END;
  `);
}
