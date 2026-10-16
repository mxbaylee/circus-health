import type { Database } from './database.ts';
import { disposableSqlite } from './disposable-sqlite.ts';
const policyScratch = new WeakMap<Database, Set<ReturnType<typeof disposableSqlite>>>();
/** One bounded private scratch database per host review, shared by its source scopes. */
export function createReviewIssueScratch(owner: Database) {
  const scratch = disposableSqlite('circus-review-issues-');
  let active = policyScratch.get(owner);
  if (!active) policyScratch.set(owner, (active = new Set()));
  active.add(scratch);
  return {
    db: scratch.db,
    close() {
      active.delete(scratch);
      scratch.close();
    },
  };
}
/** Scalar resource observability; no issue content or source identities leave the owner. */
export function reviewIssueScratchCounts(owner: Database) {
  let databases = 0,
    scopes = 0,
    rows = 0;
  for (const scratch of policyScratch.get(owner) || []) {
    databases++;
    if (!scratch.db.isOpen) continue;
    for (const [table, kind] of [
      ['intake_review_issue_scope', 'scopes'],
      ['intake_review_issue_policy_v2', 'rows'],
    ] as const) {
      if (
        !scratch.db
          .prepare("SELECT 1 FROM sqlite_temp_master WHERE type='table' AND name=?")
          .get(table)
      )
        continue;
      const count = Number(scratch.db.prepare('SELECT count(*) AS n FROM ' + table).get()!.n);
      if (kind === 'scopes') scopes += count;
      else rows += count;
    }
  }
  return { databases, scopes, rows };
}
export function clearReviewIssueScratch(owner: Database) {
  const active = policyScratch.get(owner);
  policyScratch.delete(owner);
  for (const scratch of active || []) scratch.close();
  active?.clear();
}
