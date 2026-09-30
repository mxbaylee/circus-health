import { resolveClinicalReference } from './clinical-references.ts';
import type { Database } from './database.ts';
import { HttpError, required } from './database.ts';
import { documentPersonId } from './queries.ts';

/** Ownership is evidence on the saved entity, never a guess from its linked sources. */
export function recordOwner(db: Database, type: string, id: string): string | null {
  if (type === 'historical') {
    const note = db
      .prepare(
        "SELECT json_extract(profile_json,'$.recordOwnerPersonId') AS owner_person_id FROM notes WHERE id=?",
      )
      .get(id);
    if (note) return String(note.owner_person_id || 'patient');
    type = 'document';
  }
  if (type === 'note' || type === 'person') {
    const row = required(
      db
        .prepare(
          "SELECT kind,person_id,json_extract(profile_json,'$.recordOwnerPersonId') AS owner_person_id FROM notes WHERE id=? OR person_id=?",
        )
        .get(id, id),
      'Entry not found',
    );
    return String(row.kind === 'person' ? row.person_id : row.owner_person_id || 'patient');
  }
  const resolved = resolveClinicalReference(db, type, id);
  if (resolved) {
    type = resolved.kind;
    id = resolved.recordId;
  }
  const table = (
    {
      observation: 'observations',
      medication: 'medications',
      procedure: 'procedures',
      document: 'documents',
    } as Record<string, string>
  )[type];
  if (table) {
    const row = required(
      db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id),
      'Record not found',
    );
    return type === 'document' ? documentPersonId(row.extra_json) : String(row.person_id);
  }
  if (['source', 'source_file', 'test_type'].includes(type)) return null;
  throw new HttpError(400, 'INVALID_TARGET', 'This entry has no supported person scope.');
}
