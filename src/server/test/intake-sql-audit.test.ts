import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { installIntakeSqlAudit, SQL_AUDIT_VERSION } from './helpers/intake-sql-audit.ts';

for (const recursive of [0, 1]) {
  test(`SQL mutation audit retains singleton replacement deletes with recursive_triggers=${recursive}`, () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(`PRAGMA recursive_triggers=${recursive};
        CREATE TABLE __record_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),profile_id TEXT NOT NULL,projection INTEGER NOT NULL,schema_version INTEGER NOT NULL,sequence INTEGER NOT NULL,head_json TEXT);
        CREATE TABLE ordinary(id INTEGER PRIMARY KEY,value TEXT);
      `);
      const first = [1, 'Fictional π', 1, 2, 9, '{"note":"💚"}'];
      const replacement = [1, 'Fictional π', 1, 2, 100, '{"note":"é"}'];
      const upserted = [1, 'Fictional π', 1, 2, 101, '{"note":"更新"}'];
      const size = (row: (string | number)[]) =>
        row.reduce<number>((sum, value) => sum + Buffer.byteLength(String(value)), 0);
      const b1 = size(first),
        b2 = size(replacement),
        b3 = size(upserted);
      installIntakeSqlAudit(db);
      assert.equal(SQL_AUDIT_VERSION, 2);
      const check = (
        inserts: number,
        updates: number,
        deletes: number,
        newBytes: number,
        oldBytes: number,
      ) => {
        assert.deepEqual(
          db.prepare("SELECT * FROM mutation_sql_writes WHERE table_name='__record_state'").get(),
          Object.assign(Object.create(null), {
            table_name: '__record_state',
            inserts,
            updates,
            deletes,
            new_value_bytes: newBytes,
            old_value_bytes: oldBytes,
          }),
        );
        assert.equal(db.prepare('PRAGMA recursive_triggers').get()!.recursive_triggers, recursive);
      };
      const put = db.prepare('INSERT OR REPLACE INTO __record_state VALUES(?,?,?,?,?,?)');
      put.run(...first);
      check(1, 0, 0, b1, 0);
      put.run(...replacement);
      check(2, 0, 1, b1 + b2, b1);
      db.prepare('INSERT OR IGNORE INTO __record_state VALUES(?,?,?,?,?,?)').run(...first);
      check(2, 0, 1, b1 + b2, b1);
      db.prepare(
        'INSERT INTO __record_state VALUES(?,?,?,?,?,?) ON CONFLICT(singleton) DO UPDATE SET sequence=excluded.sequence,head_json=excluded.head_json',
      ).run(...upserted);
      check(2, 1, 1, b1 + b2 + b3, b1 + b2);
      db.exec('BEGIN');
      put.run(...first);
      db.exec('ROLLBACK');
      check(2, 1, 1, b1 + b2 + b3, b1 + b2);
      assert.equal(db.prepare('SELECT bytes FROM mutation_record_state_shadow').get()!.bytes, b3);
      db.exec('DELETE FROM __record_state');
      check(2, 1, 2, b1 + b2 + b3, b1 + b2 + b3);
      assert.equal(
        db.prepare('SELECT count(*) AS n FROM mutation_record_state_shadow').get()!.n,
        0,
      );
      put.run(...first);
      check(3, 1, 2, 2 * b1 + b2 + b3, b1 + b2 + b3);
      assert.throws(() => put.run(2, ...first.slice(1)), /CHECK constraint/);
      check(3, 1, 2, 2 * b1 + b2 + b3, b1 + b2 + b3);
      db.prepare('INSERT INTO ordinary VALUES(?,?)').run(7, 'é');
      db.prepare('UPDATE ordinary SET value=? WHERE id=7').run('💚');
      db.exec('DELETE FROM ordinary');
      assert.deepEqual(
        db.prepare("SELECT * FROM mutation_sql_writes WHERE table_name='ordinary'").get(),
        Object.assign(Object.create(null), {
          table_name: 'ordinary',
          inserts: 1,
          updates: 1,
          deletes: 1,
          new_value_bytes: 8,
          old_value_bytes: 8,
        }),
      );
    } finally {
      db.close();
    }
  });
}
