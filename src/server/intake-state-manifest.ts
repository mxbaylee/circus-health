/** Private disposable copy preparation. This index never selects durable authority. */
import { createHash } from 'node:crypto';
import { disposableSqlite } from './disposable-sqlite.ts';
import { invalid } from './intake-state-evidence.ts';

export class IntakeStateManifest {
  private readonly scratch = disposableSqlite('intake-state-copy-');
  readonly db = this.scratch.db;
  constructor() {
    try {
      this.db.exec(`
      CREATE TABLE originals(id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE source(key TEXT PRIMARY KEY, value TEXT NOT NULL, prefix TEXT NOT NULL);
      CREATE INDEX source_namespace ON source(prefix,key);
      CREATE TABLE prepared(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE namespaces(prefix TEXT PRIMARY KEY);
      CREATE TABLE visited(key TEXT PRIMARY KEY);
    `);
      // Only this manifest owns the scratch connection. Keep its work in one
      // transaction instead of committing every copied row/tree visit. It is
      // never reopened as evidence or published: close discards the transaction
      // and removes the private files. Cache/temporary storage remain bounded
      // and disk-backed; the source and accepted journal use their own owners.
      this.db.exec('BEGIN');
    } catch (error) {
      this.scratch.close();
      throw error;
    }
  }
  put(table: 'source' | 'prepared', key: string, value: string, prefix = ''): void {
    const result =
      table === 'source'
        ? this.db
            .prepare('INSERT INTO source VALUES(?,?,?) ON CONFLICT(key) DO NOTHING')
            .run(key, value, prefix)
        : this.db
            .prepare('INSERT INTO prepared VALUES(?,?) ON CONFLICT(key) DO NOTHING')
            .run(key, value);
    if (!result.changes) invalid('duplicate copy contribution');
  }
  *rows(table: 'source' | 'prepared'): Generator<{ key: string; value: string }> {
    for (const row of this.db.prepare(`SELECT key,value FROM ${table} ORDER BY key`).iterate())
      yield { key: String(row.key), value: String(row.value) };
  }
  fingerprint(): string {
    const hash = createHash('sha256');
    for (const table of ['originals', 'source', 'prepared'] as const) {
      hash.update(table);
      const columns = table === 'originals' ? 'id,value' : 'key,value';
      for (const row of this.db.prepare(`SELECT ${columns} FROM ${table} ORDER BY 1`).iterate()) {
        for (const value of Object.values(row)) {
          const text = String(value);
          hash.update(String(Buffer.byteLength(text)) + ':');
          hash.update(text);
        }
      }
    }
    return hash.digest('hex');
  }
  close(): void {
    this.scratch.close();
  }
}
