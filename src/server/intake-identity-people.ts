import { challengedKnownNames, effectiveKnownNames } from './name-associations.ts';
import type { DatabaseSync } from 'node:sqlite';
import { json } from './database.ts';
import { safeSourceIdentityName } from '../shared/self-identity.ts';
import { noteVisibilitySQL } from './visibility.ts';
import type { IdentityPolicyPersonSnapshot } from './intake-identity-policy.ts';
import { selectedSequence } from './intake-selected-sequence.ts';

/** Read every active Person before choosing an owner; a page limit could hide a collision. */
export function identityPeopleSnapshots(db: DatabaseSync): IdentityPolicyPersonSnapshot[] {
  return [...selectedIdentityPeopleSnapshots(db)];
}
/** Complete repeatable policy traversal; the browser's bounded Person choices are separate. */
export function selectedIdentityPeopleSnapshots(db: DatabaseSync) {
  return selectedSequence(function* () {
    for (const row of db
      .prepare(
        `SELECT n.id,n.person_id,n.title,n.version,n.profile_json FROM notes n WHERE n.kind='person' AND n.person_id!='patient' AND ${noteVisibilitySQL('n')}=0 ORDER BY n.id`,
      )
      .iterate()) {
      const profile = json(row.profile_json, {}) as Record<string, unknown>;
      const names = effectiveKnownNames(db, String(row.id), profile).filter(safeSourceIdentityName);
      yield {
        noteId: String(row.id),
        personId: String(row.person_id),
        version: Number(row.version),
        // A title/display name is not a claimed source identity.
        fullName:
          (typeof profile.fullName === 'string' ? profile.fullName.trim() : '') || names[0] || '',
        knownNames: names,
        challengedNames: challengedKnownNames(db, String(row.id)),
        birthDate:
          typeof profile.birthDate === 'string' && profile.birthDate.trim()
            ? profile.birthDate.trim()
            : null,
      };
    }
  });
}
