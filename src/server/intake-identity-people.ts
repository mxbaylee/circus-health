import type { DatabaseSync } from 'node:sqlite';
import { json } from './database.ts';
import { savedKnownNames } from '../shared/self-identity.ts';
import { noteVisibilitySQL } from './visibility.ts';
import type { IdentityPolicyPersonSnapshot } from './intake-identity-policy.ts';

/** Read every active Person before choosing an owner; a page limit could hide a collision. */
export function identityPeopleSnapshots(db: DatabaseSync): IdentityPolicyPersonSnapshot[] {
  return db
    .prepare(
      `SELECT n.id,n.person_id,n.title,n.version,n.profile_json FROM notes n WHERE n.kind='person' AND n.person_id!='patient' AND ${noteVisibilitySQL('n')}=0 ORDER BY n.id`,
    )
    .all()
    .map((row) => {
      const profile = json(row.profile_json, {}) as Record<string, unknown>;
      const sources = Array.isArray(profile.sourceKnownNames)
        ? profile.sourceKnownNames.flatMap((value) =>
            value && typeof value === 'object' && 'name' in value && typeof value.name === 'string'
              ? [value.name]
              : [],
          )
        : [];
      const names = [...savedKnownNames(profile.knownNames), ...sources];
      return {
        noteId: String(row.id),
        personId: String(row.person_id),
        version: Number(row.version),
        // A title/display name is not a claimed source identity.
        fullName:
          (typeof profile.fullName === 'string' ? profile.fullName.trim() : '') || names[0] || '',
        knownNames: names,
        birthDate:
          typeof profile.birthDate === 'string' && profile.birthDate.trim()
            ? profile.birthDate.trim()
            : null,
      };
    });
}
