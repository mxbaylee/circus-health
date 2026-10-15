/** Disposable, source-addressed pending-window lookup. Durable ledgers remain authority. */
import { setImmediate } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import type { Database } from './database.ts';
import type { ReadWindow } from './intake-continuation.ts';

function tables(db: Database) {
  db.exec(`CREATE TEMP TABLE IF NOT EXISTS reading_pending_heads (
    id TEXT PRIMARY KEY, binding TEXT NOT NULL, ready INTEGER NOT NULL
  );
  CREATE TEMP TABLE IF NOT EXISTS reading_pending_windows (
    id TEXT NOT NULL, key TEXT NOT NULL, source TEXT NOT NULL,
    member TEXT NOT NULL, page INTEGER NOT NULL, unit TEXT NOT NULL,
    offset INTEGER, PRIMARY KEY(id,key)
  );
  CREATE INDEX IF NOT EXISTS temp.reading_pending_pages
    ON reading_pending_windows(id,source,page);
  CREATE INDEX IF NOT EXISTS temp.reading_pending_units
    ON reading_pending_windows(id,source,unit);
  CREATE INDEX IF NOT EXISTS temp.reading_pending_offsets
    ON reading_pending_windows(id,source,offset);`);
}
function put(db: Database, id: string, key: string, window: ReadWindow) {
  const a = window.args;
  db.prepare(
    `INSERT OR REPLACE INTO temp.reading_pending_windows
    (id,key,source,member,page,unit,offset) VALUES(?,?,?,?,?,?,?)`,
  ).run(
    id,
    key,
    a.id || '',
    a.memberId || '',
    a.page || 1,
    a.unitId || '',
    !a.unitId && !a.page ? a.offset || 0 : null,
  );
}
function selected(db: Database, id: string, binding: string) {
  const row = db.prepare('SELECT binding,ready FROM temp.reading_pending_heads WHERE id=?').get(id);
  return row?.binding === binding && row.ready === 1;
}
export async function prepareReadingPendingIndex(
  db: Database,
  id: string,
  binding: string,
  entries: () => Iterable<{ key: string; window: ReadWindow }>,
  assertCurrent: () => void,
) {
  tables(db);
  assertCurrent();
  if (!selected(db, id, binding)) {
    const token = 'rebuilding:' + randomUUID();
    db.prepare('INSERT OR REPLACE INTO temp.reading_pending_heads VALUES(?,?,0)').run(id, token);
    const owns = () =>
      db.prepare('SELECT binding FROM temp.reading_pending_heads WHERE id=?').get(id)?.binding ===
      token;
    const current = () => {
      assertCurrent();
      if (!owns()) throw Error('Pending reading preparation changed');
    };
    let count = 0;
    try {
      // Replaced rows are disposable too. Delete bounded batches so even a
      // large stale projection remains interruptible before the next rebuild.
      const remove = db.prepare(`DELETE FROM temp.reading_pending_windows
        WHERE id=? AND key IN (SELECT key FROM temp.reading_pending_windows WHERE id=? LIMIT 32)`);
      for (;;) {
        current();
        const removed = Number(remove.run(id, id).changes);
        if (!removed) break;
        await setImmediate();
      }
      for (const entry of entries()) {
        current();
        put(db, id, entry.key, entry.window);
        if (++count % 32 === 0) await setImmediate();
      }
      current();
      db.prepare(
        'UPDATE temp.reading_pending_heads SET binding=?,ready=1 WHERE id=? AND binding=?',
      ).run(binding, id, token);
    } catch (error) {
      try {
        db.prepare('DELETE FROM temp.reading_pending_heads WHERE id=? AND binding=?').run(
          id,
          token,
        );
      } catch {
        /* Profile lock already discards its temporary index. */
      }
      throw error;
    }
  }
  const check = () => {
    assertCurrent();
    if (!selected(db, id, binding)) throw Error('Pending reading index changed');
  };
  return {
    page(source: string, page: number) {
      check();
      return !!db
        .prepare(
          `SELECT 1 FROM temp.reading_pending_windows
        WHERE id=? AND source=? AND page=? LIMIT 1`,
        )
        .get(id, source, page);
    },
    unit(source: string, unit: string) {
      check();
      return !!db
        .prepare(
          `SELECT 1 FROM temp.reading_pending_windows
        WHERE id=? AND source=? AND unit=? LIMIT 1`,
        )
        .get(id, source, unit);
    },
    text(source: string, end?: number) {
      check();
      if (end === undefined)
        return !!db
          .prepare(
            `SELECT 1 FROM temp.reading_pending_windows
          WHERE id=? AND source=? AND offset IS NOT NULL LIMIT 1`,
          )
          .get(id, source);
      return !!db
        .prepare(
          `SELECT 1 FROM temp.reading_pending_windows
        WHERE id=? AND source=? AND offset IS NOT NULL AND offset<? LIMIT 1`,
        )
        .get(id, source, end);
    },
  };
}

/** A successful ledger transition updates only windows changed by that read. */
export function advanceReadingPendingIndex(
  db: Database,
  id: string,
  before: string,
  after: string,
  changes: Iterable<readonly [string, ReadWindow | null]>,
) {
  const update = beginReadingPendingIndexUpdate(db, id, before);
  if (!update) return;
  for (const [key, window] of changes) update.change(key, window);
  update.finish(after);
}

/** Apply each changed window during bounded ledger preparation. No second list
 * of removed windows is accumulated. Interrupted updates stay unavailable. */
export function beginReadingPendingIndexUpdate(db: Database, id: string, before: string) {
  tables(db);
  if (!selected(db, id, before)) return;
  const token = 'preparing:' + randomUUID();
  db.prepare('UPDATE temp.reading_pending_heads SET binding=?,ready=0 WHERE id=?').run(token, id);
  const owns = () =>
    db.prepare('SELECT binding FROM temp.reading_pending_heads WHERE id=?').get(id)?.binding ===
    token;
  let changed = false;
  return {
    change(key: string, window: ReadWindow | null) {
      if (!owns()) return;
      changed = true;
      if (window) put(db, id, key, window);
      else db.prepare('DELETE FROM temp.reading_pending_windows WHERE id=? AND key=?').run(id, key);
    },
    finish(after: string) {
      if (owns())
        db.prepare('UPDATE temp.reading_pending_heads SET binding=?,ready=1 WHERE id=?').run(
          after,
          id,
        );
    },
    unchanged() {
      if (!changed && owns())
        db.prepare('UPDATE temp.reading_pending_heads SET binding=?,ready=1 WHERE id=?').run(
          before,
          id,
        );
    },
  };
}
