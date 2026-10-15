import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Private scratch index. Never retained, published, or reopened as evidence. */
export function disposableSqlite(prefix: string) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  let db: DatabaseSync | undefined;
  try {
    chmodSync(directory, 0o700);
    const path = join(directory, 'scratch.sqlite');
    db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    db.exec(
      'PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=FILE; PRAGMA cache_size=-2048;',
    );
    const opened = db;
    let closed = false;
    return {
      db: opened,
      close() {
        if (closed) return;
        closed = true;
        try {
          opened.close();
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    db?.close();
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
