import { json } from './database.ts';
import type { Database, SqliteRow } from './database.ts';
import type { OpticalPrescription, VisionPrescriptionRecord } from '../shared/vision.ts';
import { pagination, evidenceFor } from './queries.ts';
import { visibilityCondition, visibilitySQL } from './visibility.ts';
import { opticalPrescriptionProblem } from './optical-prescription.ts';

// Only reviewed document mappings participate. Each retained source entry gets
// its own row, including separate evidence entries with identical values/dates.
interface VisionRow extends SqliteRow {
  id: string;
  occurrence_id: string | null;
  title: string;
  effective_at: string | null;
  provider_name: string | null;
  occurrence_source_id: string | null;
  source_record_id: string;
  extra_json: string;
}
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function visionPrescriptions(
  db: Database,
  params: URLSearchParams,
): {
  data: VisionPrescriptionRecord[];
  total: number;
  limit: number;
  offset: number;
} {
  const where = [
    "json_type(d.extra_json, '$.import.acceptedMapping.opticalPrescription')='object'",
    visibilityCondition(params, visibilitySQL("'document'", 'd.id')),
  ];
  const args: string[] = [];
  for (const [parameter, column, operator] of [
    ['documentId', 'd.id', '='],
    ['providerId', 'd.provider_id', '='],
    ['from', 'd.effective_at', '>='],
    ['to', 'd.effective_at', '<='],
  ]) {
    const value = params.get(parameter);
    if (value) {
      where.push(`${column} ${operator} ?`);
      args.push(parameter === 'to' && value.length === 10 ? value + 'T23:59:59.999Z' : value);
    }
  }
  if (params.get('q')) {
    where.push(
      "(d.title LIKE ? OR d.text_content LIKE ? OR json_extract(d.extra_json,'$.import.acceptedMapping.opticalPrescription') LIKE ?)",
    );
    args.push(...Array(3).fill('%' + params.get('q') + '%'));
  }
  const join =
    " FROM documents d LEFT JOIN providers p ON p.id=d.provider_id LEFT JOIN evidence e ON e.entity_type='document' AND e.entity_id=d.id WHERE " +
    where.join(' AND ');
  const page = pagination(params);
  const rows = db
    .prepare(
      'SELECT d.*, p.name AS provider_name, e.source_record_id AS occurrence_source_id, e.id AS occurrence_id' +
        join +
        ` ORDER BY d.effective_at IS NULL, d.effective_at ${params.get('sort') === 'oldest' ? 'ASC' : 'DESC'}, d.id, e.id LIMIT ? OFFSET ?`,
    )
    .all(...args, page.limit, page.offset);
  return {
    data: rows.map((valueRow) => {
      const row = valueRow as VisionRow;
      const extra = json(row.extra_json),
        imported = isRecord(extra) ? extra.import : null,
        acceptedMapping = isRecord(imported) ? imported.acceptedMapping : null,
        opticalPrescription = isRecord(acceptedMapping)
          ? acceptedMapping.opticalPrescription
          : null;
      if (opticalPrescriptionProblem(opticalPrescription))
        throw new Error('Accepted optical prescription is invalid');
      return {
        id: row.id,
        occurrenceId: row.occurrence_id || row.id,
        title: row.title,
        date: row.effective_at,
        provider: row.provider_name,
        sourceRecordId: row.occurrence_source_id || row.source_record_id,
        opticalPrescription: opticalPrescription as OpticalPrescription,
        evidence: evidenceFor(db, 'document', row.id),
      };
    }),
    total: Number(
      (db.prepare('SELECT count(*) AS n' + join).get(...args) as { n: number } | undefined)?.n ?? 0,
    ),
    ...page,
  };
}
