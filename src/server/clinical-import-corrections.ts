import { HttpError, clinicalReviewRevision, type Database } from './database.ts';
import {
  clinicalTables,
  resolveClinicalReference,
  type ClinicalKind,
} from './clinical-references.ts';
import { readReviewDraftHistoryPage } from './intake-review-draft-state.ts';
import type { ClinicalImportCorrectionHistoryPage } from '../shared/clinical-import-corrections.ts';
import type { AcceptedContribution } from './ownership-contributions.ts';

/** Complete native history is joined from immutable accepted occurrence
 * decisions. Pages never collect a clinical record's source-ID fan-in. */
export function clinicalImportCorrectionHistory(
  db: Database,
  input: {
    profileId: string;
    kind?: unknown;
    recordId?: unknown;
    after?: unknown;
    limit?: unknown;
  },
): ClinicalImportCorrectionHistoryPage {
  if (
    db.prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'").get()?.value !==
    input.profileId
  )
    throw new HttpError(403, 'PROFILE_BOUNDARY', 'Import history belongs to another profile');
  const limit = input.limit == null ? 20 : Number(input.limit);
  if (
    typeof input.kind !== 'string' ||
    !Object.hasOwn(clinicalTables, input.kind) ||
    typeof input.recordId !== 'string' ||
    !input.recordId ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 50
  )
    throw new HttpError(
      400,
      'IMPORT_CORRECTION_HISTORY',
      'Choose a clinical record and bounded history page',
    );
  const resolved = resolveClinicalReference(db, input.kind, input.recordId);
  if (!resolved)
    throw new HttpError(404, 'RECORD_NOT_FOUND', 'Clinical record not found in this profile');
  const kind = resolved.kind as ClinicalKind,
    recordId = resolved.recordId,
    binding = JSON.stringify([input.profileId, kind, recordId, clinicalReviewRevision(db)]);
  let sourceAfter = '',
    decisionAfter = '';
  if (input.after != null) {
    if (typeof input.after !== 'string' || input.after.length > 8192)
      throw new HttpError(400, 'IMPORT_CORRECTION_CURSOR', 'Use the next history page cursor');
    try {
      const cursor = JSON.parse(Buffer.from(input.after, 'base64url').toString());
      if (
        !Array.isArray(cursor) ||
        cursor.length !== 3 ||
        cursor[0] !== binding ||
        typeof cursor[1] !== 'string' ||
        typeof cursor[2] !== 'string'
      )
        throw Error('Stale cursor');
      sourceAfter = cursor[1];
      decisionAfter = cursor[2];
    } catch {
      throw new HttpError(409, 'IMPORT_CORRECTION_CURSOR', 'Reload the changed import history');
    }
  }
  const rows = db
    .prepare(
      `
    WITH sources(id) AS (
      SELECT source_record_id FROM ${clinicalTables[kind]} WHERE id=? AND source_record_id IS NOT NULL
      UNION SELECT source_record_id FROM evidence WHERE entity_type=? AND entity_id=?
    )
    SELECT b.id,b.created_at,
      json_extract(b.coverage_json,'$.sourceRecordId') source_record_id,
      json_extract(b.coverage_json,'$.intakeId') intake_id,
      json_extract(b.coverage_json,'$.candidateId') candidate_id,
      json_extract(b.coverage_json,'$.candidateVersionId') candidate_version_id,
      json_extract(b.coverage_json,'$.proposalId') proposal_id,
      json_extract(b.coverage_json,'$.reviewDraftId') draft_id,
      json_extract(b.coverage_json,'$.reviewDraftHistory') history
    FROM sources s JOIN manual_batches b
      ON json_extract(b.coverage_json,'$.sourceRecordId')=s.id
    WHERE b.title='Accepted clinical contribution'
      AND json_type(b.coverage_json,'$.reviewDraftHistory')='object'
      AND (s.id>? OR (s.id=? AND b.id>?))
    ORDER BY s.id,b.id LIMIT ?
  `,
    )
    .iterate(recordId, kind, recordId, sourceAfter, sourceAfter, decisionAfter, limit + 1);
  const entries: ClinicalImportCorrectionHistoryPage['entries'] = [];
  let complete = true;
  for (const row of rows) {
    if (entries.length === limit) {
      complete = false;
      break;
    }
    const fields = [
      'id',
      'created_at',
      'source_record_id',
      'intake_id',
      'candidate_id',
      'candidate_version_id',
      'draft_id',
      'history',
    ];
    if (
      fields.some(
        (field) => typeof row[field] !== 'string' || Buffer.byteLength(String(row[field])) > 8192,
      ) ||
      (row.proposal_id !== null && typeof row.proposal_id !== 'string')
    )
      throw Error('Invalid retained native correction provenance');
    const history = JSON.parse(String(row.history)) as NonNullable<
      AcceptedContribution['reviewDraftHistory']
    >;
    if (history.intakeId !== row.intake_id || history.corrections < 1)
      throw Error('Correction history source or complete count disagrees');
    // This bounded empty-end read verifies the exact retained header and source
    // without collecting any correction payload or historical reference array.
    readReviewDraftHistoryPage(db, { id: history.intakeId }, history, {
      section: 'corrections',
      offset: history.corrections,
      limit: 1,
    });
    entries.push({
      id: String(row.id),
      at: String(row.created_at),
      sourceRecordId: String(row.source_record_id),
      intakeId: String(row.intake_id),
      candidateId: String(row.candidate_id),
      candidateVersionId: String(row.candidate_version_id),
      proposalId: row.proposal_id as string | null,
      draftId: String(row.draft_id),
      history,
    });
  }
  const last = entries.at(-1);
  return {
    format: 'health-clinical-import-corrections-v1',
    recordId,
    kind,
    entries,
    complete,
    nextCursor: complete
      ? null
      : Buffer.from(JSON.stringify([binding, last!.sourceRecordId, last!.id])).toString(
          'base64url',
        ),
  };
}
