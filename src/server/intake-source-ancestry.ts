import { setImmediate } from 'node:timers/promises';
import type { DatabaseSync } from 'node:sqlite';
import { HttpError } from './database.ts';
import { intakeSourceParent } from './intake-state-access.ts';

/** Follow checked original identities with constant retained memory. Brent's
 * cycle detector keeps two IDs instead of a growing ancestor set. */
export function* iterateIntakeSourceAncestry(
  db: DatabaseSync,
  profileId: string,
  id: string,
  { stopAt, assertRunning = () => {} }: { stopAt?: string; assertRunning?: () => void } = {},
): Generator<{ id: string; parentId: string | undefined }, boolean> {
  const checkOwner = () => {
    assertRunning();
    if (
      db.prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'").get()?.value !==
      profileId
    )
      throw new HttpError(403, 'PROFILE_BOUNDARY', 'Source ancestry belongs to another profile');
  };
  checkOwner();
  let current: string | undefined = id,
    anchor = id,
    power = 1,
    length = 0;
  while (current !== undefined) {
    assertRunning();
    // Checking the endpoint too prevents a missing/foreign stop ID from being
    // accepted merely because its spelling matches the requested root.
    const parent = intakeSourceParent(db, current);
    if (parent != null && (typeof parent !== 'string' || !parent))
      throw new HttpError(409, 'SOURCE_ANCESTRY', 'Invalid retained source ancestry');
    yield { id: current, parentId: (parent ?? undefined) as string | undefined };
    checkOwner();
    // Async preparation may yield or migrate this source between steps. The
    // already checked edge must still select the same parent before continuing.
    if ((intakeSourceParent(db, current) ?? undefined) !== (parent ?? undefined))
      throw new HttpError(409, 'SOURCE_ANCESTRY', 'Retained source ancestry changed');
    if (current === stopAt) return true;
    current = (parent ?? undefined) as string | undefined;
    if (current !== undefined) {
      length++;
      if (current === anchor)
        throw new HttpError(409, 'SOURCE_ANCESTRY', 'Cyclic retained source ancestry');
      if (length === power) {
        anchor = current;
        power = Math.min(Number.MAX_SAFE_INTEGER, power * 2);
        length = 0;
      }
    }
  }
  checkOwner();
  return stopAt === undefined;
}

/** Async authorization uses the same checked walk as synchronous transaction
 * consumers, yielding without retaining a growing list of ancestors. */
export async function checkIntakeSourceAncestry(
  db: DatabaseSync,
  profileId: string,
  id: string,
  options: { stopAt?: string; assertRunning?: () => void } = {},
): Promise<boolean> {
  const walk = iterateIntakeSourceAncestry(db, profileId, id, options);
  let count = 0;
  for (;;) {
    const next = walk.next();
    if (next.done) return next.value;
    if (++count % 64 === 0) await setImmediate();
  }
}
