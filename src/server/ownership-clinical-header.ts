/** Ownership reads clinical scalars separately from its paged source joins. */
import { HttpError, json, type Database } from './database.ts';
import { clinicalTables, type ClinicalKind } from './clinical-references.ts';
import type { clinicalRecord } from './record-corrections.ts';
type Header = Pick<ReturnType<typeof clinicalRecord>, 'table' | 'row' | 'extra' | 'mapping'>;
export function ownershipClinicalHeader(db: Database, kind: ClinicalKind, id: string): Header {
  const table = clinicalTables[kind];
  if (!Object.hasOwn(clinicalTables, kind))
    throw new HttpError(400, 'CORRECTION_KIND', 'Choose a supported clinical kind');
  const row = db.prepare('SELECT * FROM ' + table + ' WHERE id=?').get(id) as
    Header['row'] | undefined;
  if (!row)
    throw new HttpError(404, 'RECORD_NOT_FOUND', 'Clinical record not found in this profile');
  const extra = json(row.extra_json) as Header['extra'];
  if (!extra.import?.acceptedMapping)
    throw new HttpError(
      400,
      'CORRECTION_EVIDENCE',
      'This entry has no reviewed import mapping; review its source in Imports first',
    );
  return { table, row, extra, mapping: extra.import.acceptedMapping };
}
