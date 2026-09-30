import { createHash } from 'node:crypto';
import { json, now, revision, type Database } from './database.ts';
import { canonicalLiteral } from './intake-format.ts';

export const ownershipHash = (value: unknown) =>
  createHash('sha256').update(canonicalLiteral(value)).digest('hex');
/** Stored when the person gave no reason; history must not present it as theirs. */
export const DEFAULT_OWNERSHIP_REASON = 'Corrected person assignment';
export function appendOwnershipDecision(
  db: Database,
  id: string,
  title: string,
  value: object,
  reason = DEFAULT_OWNERSHIP_REASON,
) {
  const at = now();
  db.prepare(
    "INSERT INTO manual_batches(id,title,status,created_at,verified_at,notes,coverage_json) VALUES(?,?,'verified',?,?,?,?)",
  ).run(id, title, at, at, reason, JSON.stringify({ ...value, revision: revision(db) + 1, at }));
}
export function latestOwnershipDecision<T>(
  db: Database,
  title: string,
  field: string,
  value: string,
): T | null {
  // Field names are call-site constants, never request input.
  if (!/^[a-zA-Z]+$/.test(field)) throw new Error('Invalid ownership journal field');
  const row = db
    .prepare(
      `SELECT coverage_json FROM manual_batches WHERE title=? AND json_extract(coverage_json,'$.${field}')=? ORDER BY json_extract(coverage_json,'$.revision') DESC,id DESC LIMIT 1`,
    )
    .get(title, value);
  return row ? (json(row.coverage_json) as T) : null;
}
