import { noteVisibilitySQL, visibilitySQL, visibilityCondition } from './visibility.ts';
import { collectionPredicates } from './collection-filters.ts';
import { HttpError, json, managedTimestamp, required } from './database.ts';
import type { Database, SqliteRow } from './database.ts';
import type {
  HistoricalNote,
  HistoricalNoteOptions,
  PersonalHistoricalNote,
  ProviderHistoricalNote,
} from '../shared/api.ts';
import { attachments, getNote } from './notes.ts';
import { evidenceFor, pagination } from './queries.ts';

// Explicit source types, not a guess based on a title, filename, or body keyword.
export const CLINICIAN_NOTE_TYPES = Object.freeze([
  'Anesthesia Postprocedure Evaluation',
  'Anesthesia Preprocedure Evaluation',
  'Anesthesia Procedure Notes',
  'Anesthesia ROS/PE',
  'Brief Op Note',
  'Discharge Instr - Activity',
  'Discharge Instr - Diagnoses',
  'Discharge Instr - Other Info',
  'Discharge Instructions',
  'Discharge Summary',
  'H&P',
  'H&P (View-Only)',
  'Interval H&P Note',
  'Long Operative Note',
  'MH Confidential Note (Mental Health)',
  'MH Progress Note (Mental Health)',
  'Op Note',
  'Op Notes',
  'Patient Instructions',
  'Pre-Op History',
  'Progress Notes',
  'Result Encounter Note',
  'Staff Note',
  'Telephone Encounter',
]);

// Only nonempty JSON strings can override presentation. Original fields remain
// in extra and source records, including unknown or malformed metadata values.
interface HistoricalRow extends SqliteRow {
  id: string;
  origin: 'personal' | 'provider';
  archived: number;
  title: string;
  type_label: string | null;
  date: string | null;
  event_date: string | null;
  record_date: string | null;
  date_basis: string;
  status: 'draft' | 'finished' | 'provider';
  source_id: string | null;
  source_label: string;
  source_status: string | null;
  source_type: string | null;
  source_record_id: string | null;
  content: string | null;
  acquisition_source_id: string | null;
  acquisition_source_label: string | null;
}
interface OptionRow extends SqliteRow {
  origin: 'personal' | 'provider';
  source_id: string | null;
  source_label: string;
  type_label: string | null;
  acquisition_source_id: string | null;
  acquisition_source_label: string | null;
}
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const textField = (path: string): string =>
  `CASE WHEN json_type(d.extra_json,'${path}')='text' AND trim(json_extract(d.extra_json,'${path}'))<>'' THEN json_extract(d.extra_json,'${path}') END`;
const reviewed = (key: string): string => textField('$.historicalNote.' + key);
const original = (key: string): string => textField('$.sourceFields.' + key);
function collection(): string {
  return `WITH historical AS (
    SELECT n.id,'personal' AS origin,n.title,n.note_type AS type_label,
      COALESCE(n.event_date,n.created_at) AS date,n.event_date,NULL AS record_date,
      CASE WHEN n.event_date IS NULL THEN 'Note creation date' ELSE 'Event date' END AS date_basis,
      n.status,'personal' AS source_id,'Personal notes' AS source_label,
      'personal' AS acquisition_source_id,'Personal notes' AS acquisition_source_label,
      NULL AS source_status,NULL AS source_type,n.source_record_id,n.content,
      n.topics || ' ' || n.raw_thoughts AS search_extra, ${noteVisibilitySQL('n')} AS archived
    FROM notes n WHERE n.kind='historical' 
    UNION ALL
    SELECT d.id,'provider',COALESCE(${reviewed('title')},d.title),
      COALESCE(${reviewed('typeLabel')},${original('type')}),
      COALESCE(${reviewed('eventDate')},d.effective_at),${reviewed('eventDate')},d.effective_at,
      COALESCE(${reviewed('dateBasis')},CASE WHEN ${reviewed('eventDate')} IS NULL THEN 'Source record date' ELSE 'Reviewed event date' END),
      'provider',d.provider_id,COALESCE(${original('source')},p.name,'Issuing provider not recorded'),
      sf.provider_id,ap.name,
      ${original('status')},${original('type')},d.source_record_id,d.text_content,
      COALESCE(json_extract(d.extra_json,'$.sourceFields.author'),''), ${visibilitySQL("'document'", 'd.id')}
    FROM documents d LEFT JOIN providers p ON p.id=d.provider_id
    LEFT JOIN source_records sr ON sr.id=d.source_record_id LEFT JOIN source_files sf ON sf.id=sr.source_file_id
    LEFT JOIN providers ap ON ap.id=sf.provider_id
    WHERE ${original('type')} IN (${CLINICIAN_NOTE_TYPES.map(() => '?').join(',')})
  )`;
}
function historicalNote(db: Database, row: HistoricalRow): HistoricalNote {
  const common = {
    id: row.id,
    origin: row.origin,
    archived: Boolean(row.archived),
    title: row.title,
    typeLabel: row.type_label,
    date: row.date,
    eventDate: row.event_date,
    recordDate: row.record_date,
    dateBasis: row.date_basis,
    status: row.status,
    sourceId: row.source_id,
    sourceLabel: row.source_label,
    sourceStatus: row.source_status,
    sourceType: row.source_type,
    sourceRecordId: row.source_record_id,
    content: row.content,
  };
  if (row.origin === 'personal') {
    const note = getNote(db, row.id);
    return {
      ...common,
      origin: 'personal',
      status: note.status === 'finished' ? 'finished' : 'draft',
      sourceId: 'personal',
      date: note.eventDate ?? managedTimestamp(row.date),
      readOnly: note.status === 'finished',
      authors: [],
      classificationBasis: null,
      presentationNote: null,
      evidence: evidenceFor(db, 'note', row.id),
      attachments: note.attachments,
      note,
    } satisfies PersonalHistoricalNote;
  }
  const document = required(
    db.prepare('SELECT extra_json FROM documents WHERE id=?').get(row.id) as
      { extra_json: string | null } | undefined,
  );
  const extra = json(document.extra_json, {});
  const extraRecord = isRecord(extra) ? extra : {};
  const sourceFields = isRecord(extraRecord.sourceFields) ? extraRecord.sourceFields : {};
  const author = sourceFields.author;
  const metadata = isRecord(extraRecord.historicalNote) ? extraRecord.historicalNote : {};
  const metadataText = (key: string): string | null => {
    const value = metadata[key];
    return typeof value === 'string' && value.trim() ? value : null;
  };
  return {
    ...common,
    origin: 'provider',
    status: 'provider',
    readOnly: true,
    authors: (Array.isArray(author) ? author : [author]).filter(
      (value): value is string => typeof value === 'string' && Boolean(value.trim()),
    ),
    classificationBasis: metadataText('classificationBasis'),
    presentationNote: metadataText('presentationNote'),
    evidence: evidenceFor(db, 'document', row.id),
    attachments: attachments(db, 'document', row.id),
    extra,
  } satisfies ProviderHistoricalNote;
}
export function historicalNotes(db: Database, params: URLSearchParams) {
  const status = params.get('status') || 'all';
  if (!['all', 'draft', 'finished', 'provider'].includes(status))
    throw new HttpError(400, 'INVALID_INPUT', 'Unknown historical note status');
  const conditions = [visibilityCondition(params, 'archived')],
    args: string[] = [...CLINICIAN_NOTE_TYPES];
  if (status !== 'all') {
    conditions.push('status=?');
    args.push(status);
  }
  const source = params.get('source') || 'all';
  if (source === 'personal' || source === 'provider') {
    conditions.push('origin=?');
    args.push(source);
  } else if (source !== 'all') {
    conditions.push("origin='provider' AND source_id=?");
    args.push(source);
  }
  if (params.get('typeLabel')) {
    const typeLabel = params.get('typeLabel');
    if (!typeLabel) throw new Error('Unreachable empty type label');
    conditions.push('type_label=? COLLATE NOCASE');
    args.push(typeLabel);
  }
  if (params.get('q')) {
    conditions.push(
      '(title LIKE ? OR content LIKE ? OR type_label LIKE ? OR source_label LIKE ? OR search_extra LIKE ?)',
    );
    args.push(...Array(5).fill('%' + params.get('q') + '%'));
  }
  const filters = collectionPredicates(params, 'historical');
  conditions.push(...filters.conditions);
  args.push(...filters.args);
  const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
  const sql = collection();
  const total = Number(
    (
      db.prepare(sql + ' SELECT COUNT(*) n FROM historical' + where).get(...args) as
        { n: number } | undefined
    )?.n ?? 0,
  );
  const pg = pagination(params);
  pg.limit = Math.floor(pg.limit);
  pg.offset = Math.floor(pg.offset);
  const direction = params.get('sort') === 'oldest' ? 'ASC' : 'DESC';
  const rows = db
    .prepare(
      sql +
        ' SELECT * FROM historical' +
        where +
        ` ORDER BY julianday(date) IS NULL,julianday(date) ${direction},origin,id LIMIT ? OFFSET ?`,
    )
    .all(...args, pg.limit, pg.offset);
  return {
    data: rows.map((row) => historicalNote(db, row as HistoricalRow)),
    total,
    ...pg,
    complete: pg.offset === 0 && rows.length === total,
  };
}
export function getHistoricalNote(db: Database, id: string): HistoricalNote {
  // Stable direct links remain usable for archived personal history; list and
  // options deliberately include only unarchived personal notes.
  const row = required(
    db
      .prepare(collection() + ' SELECT * FROM historical WHERE id=? ORDER BY origin LIMIT 1')
      .get(...CLINICIAN_NOTE_TYPES, id) as HistoricalRow | undefined,
    'Historical note not found',
  );
  return historicalNote(db, row);
}
export function historicalNoteOptions(db: Database): HistoricalNoteOptions {
  const rows = db
    .prepare(
      collection() +
        ' SELECT origin,source_id,source_label,type_label,acquisition_source_id,acquisition_source_label FROM historical WHERE archived=0 ORDER BY source_label,id',
    )
    .all(...CLINICIAN_NOTE_TYPES) as OptionRow[];
  const personal = rows.filter((row) => row.origin === 'personal').length;
  const sources = [
    { id: 'all', label: 'All sources', count: rows.length },
    { id: 'personal', label: 'Personal notes', count: personal },
    {
      id: 'provider',
      label: 'Provider records',
      count: rows.length - personal,
    },
  ];
  const issuers = new Map<string, { id: string; label: string; count: number }>(),
    types = new Map<string, string>();
  for (const row of rows) {
    if (row.type_label && !types.has(row.type_label.toLowerCase()))
      types.set(row.type_label.toLowerCase(), row.type_label);
    if (row.origin === 'provider' && row.source_id) {
      if (!issuers.has(row.source_id))
        issuers.set(row.source_id, {
          id: row.source_id,
          label: row.source_label,
          count: 0,
        });
      issuers.get(row.source_id)!.count++;
    }
  }
  return {
    sources: [...sources, ...issuers.values()],
    types: [...types.values()].sort((a, b) => a.localeCompare(b)),
    acquisitionSources: [
      ...new Map(
        rows.flatMap((row) =>
          row.acquisition_source_id
            ? [
                [
                  row.acquisition_source_id,
                  {
                    value: row.acquisition_source_id,
                    label: row.acquisition_source_label || row.acquisition_source_id,
                  },
                ] as const,
              ]
            : [],
        ),
      ).values(),
    ],
  };
}
