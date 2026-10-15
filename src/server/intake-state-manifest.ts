/** Private disposable copy preparation. This index never selects durable authority. */
import { createHash } from 'node:crypto';
import type { StatementSync } from 'node:sqlite';
import { disposableSqlite } from './disposable-sqlite.ts';
import { invalid } from './intake-state-evidence.ts';
import { intakeCopyTextPieces } from './intake-copy-json.ts';
import { finishIntakeCopySteps } from './intake-copy-work.ts';

export class IntakeStateManifest {
  private readonly scratch = disposableSqlite('intake-state-copy-');
  readonly db = this.scratch.db;
  private readonly sourceByKey: StatementSync;
  private readonly partRootByKey: StatementSync;
  private readonly partValuesByKey: StatementSync;
  constructor() {
    try {
      this.db.exec(`
      CREATE TABLE originals(id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE source(key TEXT PRIMARY KEY, value TEXT NOT NULL, prefix TEXT NOT NULL);
      CREATE INDEX source_namespace ON source(prefix,key);
      CREATE TABLE prepared(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE part_roots(kind TEXT NOT NULL,key TEXT NOT NULL,PRIMARY KEY(kind,key));
      CREATE TABLE part_values(kind TEXT NOT NULL,key TEXT NOT NULL,ordinal INTEGER NOT NULL,value TEXT NOT NULL,PRIMARY KEY(kind,key,ordinal));
      CREATE TABLE namespaces(prefix TEXT PRIMARY KEY);
      CREATE TABLE visited(key TEXT PRIMARY KEY);
    `);
      this.sourceByKey = this.db.prepare('SELECT value FROM source WHERE key=?');
      this.partRootByKey = this.db.prepare('SELECT 1 FROM part_roots WHERE kind=? AND key=?');
      this.partValuesByKey = this.db.prepare(
        'SELECT ordinal,value FROM part_values WHERE kind=? AND key=? AND ordinal>? ORDER BY ordinal LIMIT 1',
      );
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
  *putPartsSteps(
    table: 'originals' | 'source',
    key: string,
    pieces: Iterable<string>,
    prefix = '',
  ): Generator<void> {
    if (table === 'source') this.put('source', key, '', prefix);
    else if (!this.db.prepare('SELECT 1 FROM originals WHERE id=?').get(key))
      invalid('missing copy original for pieces');
    this.db.prepare('INSERT INTO part_roots VALUES(?,?)').run(table, key);
    const insert = this.db.prepare('INSERT INTO part_values VALUES(?,?,?,?)');
    let ordinal = 0;
    for (const piece of pieces)
      for (const part of intakeCopyTextPieces(piece)) {
        insert.run(table, key, ordinal++, part);
        yield;
      }
  }
  *valuePieces(table: 'originals' | 'source', key: string, value: string): Generator<string> {
    if (this.hasPieces(table, key)) {
      let ordinal = -1;
      for (;;) {
        const row = this.partValuesByKey.get(table, key, ordinal);
        if (!row) break;
        ordinal = Number(row.ordinal);
        yield String(row.value);
      }
    } else yield* intakeCopyTextPieces(value);
  }
  hasPieces(table: 'originals' | 'source', key: string): boolean {
    return !!this.partRootByKey.get(table, key);
  }
  value(table: 'originals' | 'source', key: string, stored: string): string {
    let result = '';
    for (const piece of this.valuePieces(table, key, stored)) result += piece;
    return result;
  }
  sourceValue(key: string, maxBytes: number): string | undefined {
    const row = this.sourceByKey.get(key);
    if (!row) return undefined;
    let result = '';
    let bytes = 0;
    for (const piece of this.valuePieces('source', key, String(row.value))) {
      bytes += Buffer.byteLength(piece);
      if (bytes > maxBytes) invalid('copy source value bytes');
      result += piece;
    }
    return result;
  }
  *rows(table: 'source' | 'prepared'): Generator<{ key: string; value: string }> {
    for (const row of this.db.prepare(`SELECT key,value FROM ${table} ORDER BY key`).iterate())
      yield {
        key: String(row.key),
        value:
          table === 'source'
            ? this.value('source', String(row.key), String(row.value))
            : String(row.value),
      };
  }
  fingerprint(): string {
    return finishIntakeCopySteps(this.fingerprintSteps());
  }
  *fingerprintSteps(): Generator<void, string> {
    const hash = createHash('sha256');
    for (const table of ['originals', 'source', 'prepared'] as const) {
      hash.update(table);
      const columns = table === 'originals' ? '*' : 'key,value';
      for (const row of this.db.prepare(`SELECT ${columns} FROM ${table} ORDER BY 1`).iterate()) {
        for (const [name, value] of Object.entries(row)) {
          const pieces =
            name === 'value' && table !== 'prepared'
              ? () =>
                  this.valuePieces(
                    table,
                    String(table === 'originals' ? row.id : row.key),
                    String(value),
                  )
              : () => intakeCopyTextPieces(String(value));
          if (table === 'originals') hash.update(value === null ? 'null:' : typeof value + ':');
          let bytes = 0;
          for (const piece of pieces()) {
            bytes += Buffer.byteLength(piece);
            yield;
          }
          hash.update(String(bytes) + ':');
          for (const piece of pieces()) {
            hash.update(piece);
            yield;
          }
        }
      }
    }
    return hash.digest('hex');
  }
  close(): void {
    this.scratch.close();
  }
}
