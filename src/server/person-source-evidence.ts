import { HttpError, json, type Database } from './database.ts';
import { noteRow, target } from './notes.ts';
import { pagination } from './queries.ts';
import { opticalPrescriptionProblem } from './optical-prescription.ts';
import type { PersonSourceEvidence, LinkTargetType } from '../shared/api.ts';

interface SourceRow {
  sourceId: string;
  label?: string | null;
  sourcePath?: string | null;
}
interface EvidenceRow {
  sourceId: string;
  entityType: LinkTargetType;
  entityId: string;
}

function filename(value: unknown) {
  if (typeof value !== 'string') return '';
  return value.replaceAll('\\', '/').split('/').filter(Boolean).at(-1)?.trim() || '';
}

function machineSourceLabel(value: string) {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))
    return true;
  if (/^[0-9a-f]{32,}$/i.test(value)) return true;
  return (
    !/\s/.test(value) &&
    value === value.toLowerCase() &&
    /^[a-z0-9]+(?:[-_:/.][a-z0-9]+)+$/.test(value)
  );
}

// Import-generated labels can be machine keys. Prefer a readable label and
// otherwise identify the retained file without exposing IDs or storage paths.
function sourceTitle(row: SourceRow) {
  const label = typeof row.label === 'string' ? row.label.trim() : '';
  if (label && /[\s.,:;()/-]/.test(label) && !label.includes('_') && !machineSourceLabel(label))
    return label;
  const file = filename(row.sourcePath);
  return file ? `Imported evidence in ${file}` : 'Retained imported evidence';
}

/** A shared exact source record is provenance, never an inferred care relationship. */
export function personSourceEvidence(db: Database, noteId: string, params: URLSearchParams) {
  const note = noteRow(db, noteId);
  if (note.kind !== 'person' || !note.person_id)
    throw new HttpError(400, 'INVALID_INPUT', 'Source evidence requires a saved Person.');
  const page = pagination(params);
  if (!Number.isSafeInteger(page.limit) || !Number.isSafeInteger(page.offset))
    throw new HttpError(400, 'INVALID_INPUT', 'Use whole-number evidence page limits.');
  // Page the Person's distinct sources first. Paginating a flattened join can
  // split one source's entries across pages or repeat that source.
  const ownedSources = `SELECT DISTINCT source_record_id
    FROM evidence WHERE entity_type='person' AND entity_id=?`;
  const total = Number(
    db.prepare(`SELECT COUNT(*) AS n FROM (${ownedSources})`).get(note.person_id)!.n,
  );
  const sources = db
    .prepare(
      `SELECT own.source_record_id AS sourceId,r.label,
          COALESCE(original.path,f.path) AS sourcePath
        FROM (${ownedSources}) own
        LEFT JOIN source_records r ON r.id=own.source_record_id
        LEFT JOIN source_files f ON f.id=r.source_file_id
        LEFT JOIN source_files original
          ON original.id=json_extract(r.locator_json,'$.originalSourceFileId')
        ORDER BY own.source_record_id LIMIT ? OFFSET ?`,
    )
    .all(note.person_id, page.limit, page.offset) as unknown as SourceRow[];
  const sourceIds = sources.map((row) => String(row.sourceId));
  const entriesBySource = new Map<string, EvidenceRow[]>();
  if (sourceIds.length) {
    const placeholders = sourceIds.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT DISTINCT source_record_id AS sourceId,entity_type AS entityType,
            entity_id AS entityId
          FROM evidence
          WHERE source_record_id IN (${placeholders})
            AND entity_type IN ('observation','medication','procedure','document')
          ORDER BY source_record_id,entity_type,entity_id`,
      )
      .all(...sourceIds) as unknown as EvidenceRow[];
    for (const row of rows) {
      const items = entriesBySource.get(String(row.sourceId)) || [];
      items.push(row);
      entriesBySource.set(String(row.sourceId), items);
    }
  }
  const data: PersonSourceEvidence[] = sources.map((sourceRow) => {
    const sourceRecordId = String(sourceRow.sourceId);
    const source = target(db, 'source', sourceRecordId);
    const seenEntries = new Set<string>();
    const entries = (entriesBySource.get(sourceRecordId) || []).flatMap((row) => {
      const entityId = String(row.entityId);
      const entityType = String(row.entityType) as LinkTargetType;
      const entry = target(db, entityType, entityId);
      const kind = entry.resolvedTargetType || entityType;
      const key = `${kind}:${entityId}`;
      if (seenEntries.has(key)) return [];
      seenEntries.add(key);
      let appUrl = entry.appUrl;
      if (kind === 'document' && !entry.missing) {
        const doc = db.prepare('SELECT extra_json FROM documents WHERE id=?').get(entityId);
        const extra = json(doc?.extra_json) as {
          import?: { acceptedMapping?: { opticalPrescription?: unknown } };
        } | null;
        const optical = extra?.import?.acceptedMapping?.opticalPrescription;
        if (optical && !opticalPrescriptionProblem(optical))
          appUrl = `/tests?view=vision&document=${encodeURIComponent(entityId)}&visibility=all`;
      }
      return [
        {
          entityId,
          kind,
          title: entry.title,
          archived: entry.archived,
          missing: entry.missing,
          ...(appUrl ? { appUrl } : {}),
        },
      ];
    });
    return {
      sourceRecordId,
      sourceTitle: sourceTitle(sourceRow),
      sourceArchived: source.archived,
      sourceMissing: source.missing,
      entries,
    };
  });
  return { data, ...page, total, complete: page.offset === 0 && data.length === total };
}
