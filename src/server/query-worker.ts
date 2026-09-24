import type { QueryData, QueryRequest } from './query-contract.ts';
import { DatabaseSync, constants as c, type SQLOutputValue } from 'node:sqlite';
process.once('message', (message) => {
  const { path, sql, params, limit } = message as QueryRequest;
  const started = performance.now();
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    db.exec('PRAGMA hard_heap_limit=67108864; PRAGMA query_only=ON; BEGIN');
    db.enableDefensive(true);
    const revision = Number(
      db.prepare("SELECT value FROM app_meta WHERE key='revision'").get()?.value || 0,
    );
    const allowed = new Set<number>([
      c.SQLITE_SELECT,
      c.SQLITE_READ,
      c.SQLITE_FUNCTION,
      c.SQLITE_RECURSIVE,
    ]);
    db.setAuthorizer((action, arg1, arg2) => {
      if (!allowed.has(action)) return c.SQLITE_DENY;
      if (
        action === c.SQLITE_FUNCTION &&
        ['load_extension', 'readfile', 'writefile', 'edit', 'randomblob', 'zeroblob'].includes(
          String(arg2 || arg1).toLowerCase(),
        )
      )
        return c.SQLITE_DENY;
      if (action === c.SQLITE_READ && String(arg1).toLowerCase().startsWith('pragma_'))
        return c.SQLITE_DENY;
      return c.SQLITE_OK;
    });
    const inner = sql.trim().replace(/;\s*$/, '');
    const stmt = db.prepare(`SELECT * FROM (${inner}) LIMIT ${limit + 1}`);
    stmt.setReadBigInts(true);
    stmt.setReturnArrays(true);
    const columns = stmt.columns().map((c) => c.name);
    if (columns.length > 200) throw new Error('Query returns more than 200 columns');
    const rows: QueryData['rows'] = [];
    let totalBytes = 0,
      truncated = false;
    // setReturnArrays(true) above determines the SQLite row shape.
    for (const row of stmt.iterate(...params) as unknown as Iterable<SQLOutputValue[]>) {
      if (rows.length === limit) {
        truncated = true;
        break;
      }
      if (
        row.some(
          (value) =>
            (typeof value === 'string' && value.length > 65536) || ArrayBuffer.isView(value),
        )
      )
        truncated = true;
      const mapped = row.map((value) =>
        typeof value === 'bigint'
          ? value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
            ? Number(value)
            : value.toString()
          : ArrayBuffer.isView(value)
            ? `[binary ${value.byteLength} bytes]`
            : typeof value === 'string' && value.length > 65536
              ? value.slice(0, 65536) + '… [cell truncated]'
              : value,
      );
      totalBytes += JSON.stringify(mapped).length;
      if (totalBytes > 2 * 1024 * 1024) {
        truncated = true;
        break;
      }
      rows.push(mapped);
    }
    process.send!({
      data: {
        columns,
        rows,
        truncated,
        revision,
        elapsedMs: Math.round(performance.now() - started),
      },
    });
  } catch (error) {
    process.send!({ error: (error as Error).message });
  } finally {
    db?.close();
    process.disconnect();
  }
});
