import { HttpError, type Database } from './database.ts';
import {
  clinicalTables,
  clinicalReferenceKinds,
  clinicalNavigation,
  resolveClinicalReference,
} from './clinical-references.ts';
import { queryRecordHistory } from './record-versions.ts';

interface HistoryOptions {
  profileId?: string;
  kind?: unknown;
  recordId?: unknown;
  field?: unknown;
  beforeSequence?: number;
  limit?: number;
}

// History follows only accepted kind transitions for this stable identity.
// Group sequence boundaries so a transition's tombstone and new-kind version
// cannot be split and lost by a beforeSequence cursor.
export function clinicalRecordHistory(
  db: Database,
  {
    profileId,
    kind,
    recordId,
    field,
    beforeSequence = Number.MAX_SAFE_INTEGER,
    limit = 50,
  }: HistoryOptions = {},
) {
  if (
    db.prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'").get()?.value !== profileId
  )
    throw new HttpError(403, 'PROFILE_BOUNDARY', 'Record history belongs to another profile');
  if (
    typeof kind !== 'string' ||
    !Object.hasOwn(clinicalTables, kind) ||
    typeof recordId !== 'string' ||
    !recordId ||
    (field !== undefined && (typeof field !== 'string' || !field || field.length > 500)) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isSafeInteger(beforeSequence) ||
    beforeSequence < 1
  )
    throw new HttpError(
      400,
      'INVALID_HISTORY',
      'Choose a clinical kind, record ID and valid history pagination',
    );
  const resolved = resolveClinicalReference(db, kind, recordId);
  if (!resolved)
    throw new HttpError(404, 'RECORD_NOT_FOUND', 'Clinical record not found in this profile');
  const kinds = clinicalReferenceKinds(db, kind, recordId);
  const pages = kinds.map((value) =>
    queryRecordHistory(db, {
      profileId,
      entity: clinicalTables[value],
      recordId,
      field,
      beforeSequence,
      limit,
    }),
  );
  const ordered = pages
    .flatMap((page) => page.entries)
    .sort((a, b) => b.sequence - a.sequence || a.entity.localeCompare(b.entity));
  const boundary = ordered[Math.min(limit, ordered.length) - 1]?.sequence;
  const entries = ordered.filter((entry) => entry.sequence >= boundary);
  const more = ordered.length > entries.length || pages.some((page) => page.nextSequence !== null);
  return {
    recordId,
    requestedKind: kind,
    currentKind: resolved.kind,
    navigation: clinicalNavigation(resolved.kind, recordId),
    kinds,
    entries,
    nextSequence: more ? boundary : null,
  };
}
