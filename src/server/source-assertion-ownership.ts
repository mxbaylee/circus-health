import { HttpError, type Database } from './database.ts';
import type { SourceAssertionOwnership } from '../shared/api.ts';

const clinicalKinds =
  "'clinical_object','allergy','allergies','allergyintolerance','condition','conditions','diagnosis','diagnoses','encounter','encounters','visit','visits','immunization','immunizations'";

/** Fixed internal aliases only; never interpolate caller-provided SQL. */
export function sourceAssertionBoundary(alias: 'sr' | 'r') {
  const unrepresentedProvider = `${alias}.provider_id IN (SELECT id FROM providers WHERE lower(name) NOT LIKE '%personal%' AND lower(id) NOT IN ('personal','self'))
    AND NOT EXISTS (SELECT 1 FROM evidence e WHERE e.source_record_id=${alias}.id AND e.entity_type<>'person')
    AND NOT EXISTS (SELECT 1 FROM observations WHERE source_record_id=${alias}.id)
    AND NOT EXISTS (SELECT 1 FROM medications WHERE source_record_id=${alias}.id)
    AND NOT EXISTS (SELECT 1 FROM procedures WHERE source_record_id=${alias}.id)
    AND NOT EXISTS (SELECT 1 FROM documents WHERE source_record_id=${alias}.id)`;
  const singleOwner = `(SELECT count(DISTINCT e.entity_id) FROM evidence e WHERE e.source_record_id=${alias}.id AND e.entity_type='person' AND e.role='report_subject')=1
    AND EXISTS (SELECT 1 FROM evidence e JOIN people p ON p.id=e.entity_id WHERE e.source_record_id=${alias}.id AND e.entity_type='person' AND e.role='report_subject')`;
  return {
    additional: `(${unrepresentedProvider} AND lower(${alias}.kind) IN (${clinicalKinds}))`,
    disclosure: `(${unrepresentedProvider} AND lower(${alias}.kind) IN (${clinicalKinds},'intake_record','intake_document'))`,
    singleOwner: `(${singleOwner})`,
  };
}

/** A read-only evidence assessment, never an approval or integrity/assignment token. */
export function sourceAssertionOwnership(db: Database, id: string): SourceAssertionOwnership {
  const boundary = sourceAssertionBoundary('sr');
  const row = db
    .prepare(
      `SELECT ${boundary.additional} additional, ${boundary.disclosure} disclosure
    FROM source_records sr WHERE sr.id=?`,
    )
    .get(id);
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Source record not found');
  const total = Number(
    db
      .prepare(
        `SELECT count(DISTINCT entity_id) n FROM evidence
    WHERE source_record_id=? AND entity_type='person' AND role='report_subject'`,
      )
      .get(id)!.n,
  );
  const limit = 100;
  const subjects = db
    .prepare(
      `SELECT DISTINCT e.entity_id, p.id existing_person FROM evidence e
    LEFT JOIN people p ON p.id=e.entity_id
    WHERE e.source_record_id=? AND e.entity_type='person' AND e.role='report_subject'
    ORDER BY e.entity_id LIMIT ?`,
    )
    .all(id, limit)
    .map((row) => ({
      personId: String(row.entity_id),
      personExists: row.existing_person !== null,
    }));
  const state =
    total === 0
      ? 'unassigned'
      : total > 1
        ? 'conflicting'
        : subjects[0]!.personExists
          ? 'single'
          : 'dangling';
  return {
    sourceRecordId: id,
    sourceRecordUrl: `/source-records/${encodeURIComponent(id)}?fileView=reference`,
    packetRole: row.additional
      ? 'additional_assertion'
      : row.disclosure
        ? 'notice_only'
        : 'outside_scope',
    state,
    ownerPersonId: state === 'single' ? subjects[0]!.personId : null,
    subjects: { items: subjects, total, limit, truncated: total > subjects.length },
    originalIntegrity: 'not_checked',
    assignmentAuthority: 'read_only',
  };
}
