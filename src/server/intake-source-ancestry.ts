import { setImmediate } from 'node:timers/promises';
import type { DatabaseSync } from 'node:sqlite';
import { HttpError } from './database.ts';
import { intakeSourceParent } from './intake-state-access.ts';
import {
  acceptedSourceReaderAttached,
  withAcceptedNativeIntakeSourceFormat,
} from './intake-accepted-source-format.ts';
import {
  captureReferencedEnvelopeReadFromFormat,
  closeReferencedEnvelopeRead,
  referencedEnvelopeCurrentExactStringField,
} from './intake-referenced-envelope-access.ts';

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

const REFERENCED_PREFIX = '{"intakeAuthority":{"format":"health-intake-envelope-v3"';

/** Routing only. With incremental (contributor) durability every edge is decided by
 * the accepted selected-source proof: a row prefix is mutable SQL and cannot
 * choose the weaker reader. Otherwise (no durability, or the cold-replay vault
 * adapter, which concurrent writes starve)
 * the SQL walk stays, except for edges it cannot decode (a referenced V3 row
 * or a legacy ID beyond the V4 identity limit), which still need the proof. */
function acceptedEdge(db: DatabaseSync, id: string): boolean {
  if (acceptedSourceReaderAttached(db)) return true;
  if (Buffer.byteLength(id) > 256) return true;
  return String(
    db
      .prepare(
        "SELECT substr(details_json,1,96) AS prefix FROM main.source_files WHERE id=? AND kind='intake_original'",
      )
      .get(id)?.prefix ?? '',
  ).startsWith(REFERENCED_PREFIX);
}

async function acceptedParent(
  db: DatabaseSync,
  profileId: string,
  id: string,
  checkOwner: () => void,
): Promise<unknown> {
  return withAcceptedNativeIntakeSourceFormat(
    db,
    profileId,
    id,
    checkOwner,
    async (format) => {
      if (format.format === 'legacy') {
        const selected = format.legacyParent();
        checkOwner();
        format.assertCurrent();
        return selected;
      }
      const scope = await captureReferencedEnvelopeReadFromFormat(
        db,
        format,
        checkOwner,
        'current',
      );
      try {
        const selected = await referencedEnvelopeCurrentExactStringField(
          scope,
          'intake.parentSourceFileId',
        );
        checkOwner();
        format.assertCurrent();
        return selected;
      } finally {
        closeReferencedEnvelopeRead(scope);
      }
    },
    true,
    true,
    // A pure read: a proof refused because a concurrent writer moved the
    // interval is repeated from scratch.
    { idempotent: true },
  );
}

/** Async authorization uses the same checked walk as synchronous transaction
 * consumers, yielding without retaining a growing list of ancestors. With
 * incremental (contributor) durability each edge is selected by the accepted source
 * proof (retained proofs make repeat edges cheap); see acceptedEdge. */
export async function checkIntakeSourceAncestry(
  db: DatabaseSync,
  profileId: string,
  id: string,
  options: { stopAt?: string; assertRunning?: () => void } = {},
): Promise<boolean> {
  const assertRunning = options.assertRunning ?? (() => {});
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
    length = 0,
    count = 0;
  while (current !== undefined) {
    assertRunning();
    const edge: string = current;
    const accepted = acceptedEdge(db, edge);
    const parent = accepted
      ? await acceptedParent(db, profileId, edge, checkOwner)
      : intakeSourceParent(db, edge);
    if (parent != null && (typeof parent !== 'string' || !parent))
      throw new HttpError(409, 'SOURCE_ANCESTRY', 'Invalid retained source ancestry');
    if (++count % 64 === 0) await setImmediate();
    checkOwner();
    // Recheck routing and SQL parents. Accepted edges have individual proof
    // intervals; supported writers set parentage at creation, never reassign it.
    if (
      acceptedEdge(db, edge) !== accepted ||
      (!accepted && (intakeSourceParent(db, edge) ?? undefined) !== (parent ?? undefined))
    )
      throw new HttpError(409, 'SOURCE_ANCESTRY', 'Retained source ancestry changed');
    if (edge === options.stopAt) return true;
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
  return options.stopAt === undefined;
}
