import { randomUUID } from 'node:crypto';
import { disposableSqlite } from './disposable-sqlite.ts';
import { createOwnershipPreviewStore } from './ownership-preview-store.ts';
import { HttpError } from './database.ts';
export function createOwnershipBlockerStore(profileId: string) {
  const scratch = disposableSqlite('circus-ownership-blocker-page-'),
    sql = scratch.db,
    token = randomUUID(),
    url =
      '/api/profiles/' +
      encodeURIComponent(profileId) +
      '/record-ownership/blocker-evidence/' +
      token;
  const sink = createOwnershipPreviewStore(sql, new Set(), url).sink;
  let assertCurrent = () => {},
    closed = false;
  const check = (key: string) => {
    if (closed) throw new HttpError(409, 'OWNERSHIP_CHANGED', 'Refresh this ownership review');
    assertCurrent();
    if (!/^[a-f0-9]{64}$/.test(key))
      throw new HttpError(400, 'OWNERSHIP_CURSOR', 'Invalid blocker selection');
  };
  return {
    token,
    sink,
    setGuard(guard: () => void) {
      assertCurrent = guard;
    },
    close() {
      if (closed) return;
      closed = true;
      scratch.close();
    },
    page(key: string, after = -1, limit = 16, bytes = 65536) {
      check(key);
      if (
        !Number.isSafeInteger(after) ||
        after < -1 ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 32 ||
        !Number.isSafeInteger(bytes) ||
        bytes < 1 ||
        bytes > 65536
      )
        throw new HttpError(400, 'OWNERSHIP_CURSOR', 'Invalid blocker page');
      const total = Number(
          sql.prepare('SELECT COUNT(*) n FROM preview_contributions WHERE record_key=?').get(key)!
            .n,
        ),
        rows = sql
          .prepare(
            'SELECT ordinal,length(CAST(value AS BLOB)) bytes FROM preview_contributions WHERE record_key=? AND ordinal>? ORDER BY ordinal LIMIT ?',
          )
          .all(key, after, limit + 1);
      let used = 0;
      const items = rows.slice(0, limit).map((row) => {
        if (Number(row.bytes) > bytes - used) {
          used += 256;
          return {
            type: 'contribution-fragment',
            ordinal: Number(row.ordinal),
            bytes: Number(row.bytes),
            url: url + '?contribution=' + key,
          };
        }
        used += Number(row.bytes);
        return JSON.parse(
          String(
            sql
              .prepare('SELECT value FROM preview_contributions WHERE record_key=? AND ordinal=?')
              .get(key, row.ordinal)!.value,
          ),
        );
      });
      return {
        items,
        total,
        complete: rows.length <= limit,
        after: rows.length > limit ? String(rows[limit - 1]!.ordinal) : null,
      };
    },
    fragment(key: string, ordinal: number, offset: number, bytes = 32768) {
      check(key);
      if (
        !Number.isSafeInteger(ordinal) ||
        ordinal < 0 ||
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(bytes) ||
        bytes < 1 ||
        bytes > 32768
      )
        throw new HttpError(400, 'OWNERSHIP_CURSOR', 'Invalid blocker fragment');
      const row = sql
        .prepare(
          'SELECT length(CAST(value AS BLOB)) total,substr(CAST(value AS BLOB),?,?) data FROM preview_contributions WHERE record_key=? AND ordinal=?',
        )
        .get(offset + 1, bytes, key, ordinal);
      if (!row || offset > Number(row.total))
        throw new HttpError(409, 'OWNERSHIP_CHANGED', 'Refresh this ownership requirement');
      const data = Buffer.from(row.data as Uint8Array),
        next = offset + data.length;
      return {
        encoding: 'base64' as const,
        data: data.toString('base64'),
        bytes: Number(row.total),
        complete: next >= Number(row.total),
        nextOffset: next < Number(row.total) ? next : null,
      };
    },
  };
}
export type OwnershipBlockerStore = ReturnType<typeof createOwnershipBlockerStore>;
const plans = new WeakMap<object, OwnershipBlockerStore>();
export function bindOwnershipBlockerStore(plan: object, store: OwnershipBlockerStore) {
  plans.set(plan, store);
}
export function ownershipBlockerStoreForPlan(plan: object | undefined) {
  return plan ? plans.get(plan) : undefined;
}
