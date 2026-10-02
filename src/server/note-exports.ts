import { readStoredIntakeDetails } from './intake-state-access.ts';
import { sourceAssertionBoundary } from './source-assertion-ownership.ts';
import { recordOwner } from './record-owner.ts';
import { resolveClinicalReference } from './clinical-references.ts';
import { ownershipCorrections, type OwnershipCorrectionHistory } from './ownership-history.ts';
import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SQLOutputValue } from 'node:sqlite';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { HttpError, required } from './database.ts';
import type { Database, SqliteRow } from './database.ts';
import type { Attachment } from '../shared/api.ts';
import { chartPoint, chartDate } from '../app/data/clinical.ts';
import { dateNumber } from '../app/data/format.ts';
import { documentPersonId, observation } from './queries.ts';
import { getNote, attachments } from './notes.ts';
import type { NoteDTO } from './notes.ts';
import { packetReportReview, type PacketReportReview } from './packet-report-review.ts';
import type { IntakeExtractionPlan } from '../shared/intake.ts';
import { accountedUnitKind } from './intake-unit-accounting.ts';

const tables = {
  note: 'notes',
  person: 'people',
  observation: 'observations',
  medication: 'medications',
  procedure: 'procedures',
  document: 'documents',
  source: 'source_records',
  source_file: 'source_files',
  test_type: 'test_types',
} as const;
type ExportRecordType = keyof typeof tables;
type ExportMode = 'brief' | 'detailed' | 'provider';
type JsonRecord = Record<string, unknown>;

interface ExportRow {
  [key: string]: SQLOutputValue | undefined;
  id?: string;
  archived?: number;
  kind?: string;
  person_id?: string;
  source_record_id?: string | null;
  provider_id?: string | null;
  locator_json?: string | null;
  extra_json?: string | null;
  profile_json?: string | null;
  raw_json?: string | null;
  title?: string | null;
  label?: string | null;
  display_name?: string | null;
  source_key?: string | null;
  path?: string | null;
  event_date?: string | null;
  effective_at?: string | null;
  start_at?: string | null;
  date_text?: string | null;
  updated_at?: string | null;
  date_precision?: string | null;
  note_type?: string | null;
  category?: string | null;
  content?: string | null;
  topics?: string | null;
  raw_thoughts?: string | null;
  text_content?: string | null;
  reference_json?: string | null;
  status?: string | null;
  value_text?: string | null;
  unit?: string | null;
  dose_text?: string | null;
  route?: string | null;
  frequency?: string | null;
  end_at?: string | null;
  test_type_id?: string | null;
  mime_type?: string | null;
  coverage_status?: string | null;
  sha256?: string | null;
  bytes?: number | null;
}

interface Citation {
  id: string;
  role: string | null;
  sourceKey?: string | null;
  issuer: unknown;
  sourceRecordProvider?: string | null;
  authors: unknown;
  acquisition?: string | null;
  file?: string | null;
  sha256?: string | null;
  coverage?: string | null;
  locator: unknown;
  sourceLocator: unknown;
  date?: string | null;
}

interface MedicationPreference {
  [key: string]: SQLOutputValue | undefined;
  status: string;
  updated_at: string;
  assertion_json?: string | null;
}

interface ExportRecord {
  key: string;
  type: ExportRecordType;
  id: string;
  title: string;
  date: string | null;
  archived: boolean;
  row: ExportRow;
  citations: Citation[];
  attachments: Attachment[];
  note?: NoteDTO;
  currentUse?: MedicationPreference | null;
  ownershipCorrections?: OwnershipCorrectionHistory[];
  fieldCorrections?: FieldCorrection[];
}

interface FieldCorrection {
  at: string;
  reason: string;
  fields: string[];
  actor: 'profile-user';
  fromKind?: string;
  toKind?: string;
}

function fieldCorrections(row: ExportRow): FieldCorrection[] {
  const extra = parsedRecord(row.extra_json);
  if (!Array.isArray(extra.recordCorrections)) return [];
  return extra.recordCorrections.flatMap((item): FieldCorrection[] => {
    if (!isRecord(item) || !isRecord(item.before) || !isRecord(item.after)) return [];
    const before = item.before,
      after = item.after;
    const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
      (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
    );
    if (!fields.length) return [];
    return [
      {
        at: typeof item.at === 'string' ? item.at : '',
        reason: typeof item.reason === 'string' ? item.reason : '',
        fields,
        actor: 'profile-user',
        ...(before.kind !== after.kind
          ? { fromKind: String(before.kind), toKind: String(after.kind) }
          : {}),
      },
    ];
  });
}

interface ExportOwner extends SqliteRow {
  owner_type: ExportRecordType;
  owner_id: string;
  event_date: string | null;
}

interface ExportAsset {
  id: string;
  originalName: string;
  originalNames?: string[];
  mimeType: string | null;
  bytes: number | null;
  sha256: string | null;
  contentUrl: string;
  owners: ExportOwner[];
}

interface PatientInformation {
  name: string;
  details: JsonRecord;
  contacts: JsonRecord[];
  caregiver?: { name: string; role: 'caregiver' };
}

export interface NoteExportInput extends JsonRecord {
  type: ExportRecordType;
  id: string;
  noteVersion?: unknown;
  mode?: ExportMode;
  selected?: unknown[];
  assets?: unknown[];
  noteIds?: unknown[];
  from?: string | null;
  to?: string | null;
  includeArchived?: boolean;
  includePatient?: boolean;
  includeAttachments?: boolean;
  includeLinked?: boolean;
  includeProcedures?: boolean;
  includePrescriptions?: boolean;
  normalizedSelection?: boolean;
  trends?: boolean;
}

export interface NoteExportSnapshot {
  reportReview: PacketReportReview[];
  unassignedRawAssertionsOmitted: boolean;
  readingGaps: {
    sourceFileId: string;
    filename: string;
    gaps: { locator: string; reason: string }[];
  }[];
  patient: PatientInformation | null;
  actor: { name: string; role: 'patient' | 'caregiver' };
  identity: { name: string; birthDate: unknown; pronouns: unknown; version: unknown };
  main: ExportRecord;
  records: ExportRecord[];
  assets: ExportAsset[];
  mode: ExportMode;
  trends: boolean;
  scope: { from: string | null; to: string | null; includeArchived: boolean };
  selection: string[];
  generatedAt: string;
  fingerprint: string;
}

const unassignedAssertionDisclosure =
  'Some retained clinical assertions have no verified single-person assignment and were left out of this packet. Review the original records before relying on this packet as complete.';

const assertionBoundary = sourceAssertionBoundary('sr');

function unassignedPacketAssertions(db: Database): boolean {
  return !!db
    .prepare(
      `SELECT 1 FROM source_records sr
    WHERE ${assertionBoundary.disclosure}
      AND NOT ${assertionBoundary.singleOwner} LIMIT 1`,
    )
    .get();
}

interface SnapshotEntry {
  profileId: string;
  input: NoteExportInput;
  snapshot: NoteExportSnapshot;
  expires: number;
}

interface NoteExportRouteContext {
  resource: string;
  id?: string;
  action?: string;
  method: string;
  req: IncomingMessage;
  res: ServerResponse;
  db: Database;
  profileId: string;
  respond(data: unknown): void;
  jsonBody(req: IncomingMessage): Promise<unknown>;
}

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const parsedRecord = (value: unknown): JsonRecord => {
  const parsed = parse(value);
  return isRecord(parsed) ? parsed : {};
};
const isExportRecordType = (value: unknown): value is ExportRecordType =>
  typeof value === 'string' && Object.hasOwn(tables, value);
const inputRecord = (value: unknown): NoteExportInput => {
  if (!isRecord(value) || !isExportRecordType(value.type) || typeof value.id !== 'string')
    throw new HttpError(400, 'INVALID_EXPORT', 'Unknown export record type.');
  const mode = value.mode;
  if (mode !== undefined && mode !== 'brief' && mode !== 'detailed' && mode !== 'provider')
    throw new HttpError(400, 'INVALID_EXPORT', 'Invalid export options.');
  return {
    ...value,
    type: value.type,
    id: value.id,
    ...(mode === undefined ? {} : { mode }),
    ...(typeof value.from === 'string' || value.from === null ? { from: value.from } : {}),
    ...(typeof value.to === 'string' || value.to === null ? { to: value.to } : {}),
    ...(Array.isArray(value.selected) ? { selected: value.selected } : {}),
    ...(Array.isArray(value.assets) ? { assets: value.assets } : {}),
    ...(Array.isArray(value.noteIds) ? { noteIds: value.noteIds } : {}),
  };
};
const parse = (s: unknown, fallback: unknown = {}): unknown => {
  try {
    return JSON.parse(s as string) as unknown;
  } catch {
    return fallback;
  }
};
const reference = (value: unknown): unknown => {
  const parsed = parse(value);
  return isRecord(parsed) &&
    Object.keys(parsed).length === 1 &&
    Object.hasOwn(parsed, 'raw') &&
    parsed.raw === null
    ? null
    : parsed;
};
const hash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const esc = (value: unknown): string =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c as '&' | '<' | '>' | '"' | "'"
      ],
  );
const missing = (value: unknown): string =>
  value === null ||
  value === undefined ||
  value === '' ||
  (typeof value === 'object' && Object.keys(value).length === 0)
    ? 'Not recorded'
    : typeof value === 'object'
      ? JSON.stringify(value)
      : String(value);
const markdown = (text: string | null | undefined): string =>
  renderToStaticMarkup(
    React.createElement(Markdown, {
      remarkPlugins: [remarkGfm],
      skipHtml: true,
      components: {
        img: ({ alt }) =>
          React.createElement(
            'span',
            null,
            `[Image reference: ${alt || 'image'}; original not embedded]`,
          ),
        a: ({ children, href }) =>
          React.createElement('span', null, children, href ? ` (${href})` : ''),
      },
      children: text || 'No content recorded.',
    }),
  );

function archived(db: Database, type: ExportRecordType, id: string, row?: ExportRow): boolean {
  if (
    type === 'medication' &&
    db.prepare('SELECT status FROM medication_preferences WHERE medication_id=?').get(id)
      ?.status === 'not_current'
  )
    return true;
  let legacy = Number(row?.archived || 0);
  if (type === 'note' && row?.kind === 'person' && typeof row.person_id === 'string') {
    type = 'person';
    id = row.person_id;
  }
  if (type === 'person') {
    if (id === 'patient') return false;
    legacy = Number(
      db.prepare('SELECT archived FROM notes WHERE person_id=?').get(id)?.archived || 0,
    );
  }
  if (
    !db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='visibility_events'")
      .get()
  )
    return Boolean(legacy);
  const event = db
    .prepare(
      'SELECT archived FROM visibility_events WHERE target_type=? AND target_id=? ORDER BY version DESC LIMIT 1',
    )
    .get(type, id);
  return Boolean(event?.archived ?? legacy);
}
function rowFor(db: Database, type: unknown, id: unknown): ExportRow {
  if (!isExportRecordType(type) || typeof id !== 'string')
    throw new HttpError(400, 'INVALID_EXPORT', 'Unknown export record type.');
  return required(
    db.prepare(`SELECT * FROM ${tables[type]} WHERE id=?`).get(id) as ExportRow | undefined,
    'Selected export record is unavailable in this profile.',
  );
}
interface EvidenceRow extends SqliteRow {
  source_record_id: string;
  locator_json: string | null;
  role: string | null;
}
interface CitationSourceRow extends SqliteRow {
  source_key: string | null;
  issuer: string | null;
  acquisition: string | null;
  path: string | null;
  sha256: string | null;
  coverage_status: string | null;
  locator_json: string | null;
  date_text: string | null;
}
function citations(db: Database, type: ExportRecordType, id: string, row: ExportRow): Citation[] {
  const refs = db
    .prepare(
      'SELECT source_record_id,locator_json,role FROM evidence WHERE entity_type=? AND entity_id=? ORDER BY id',
    )
    .all(type, id) as unknown as EvidenceRow[];
  if (row.source_record_id && !refs.some((r) => r.source_record_id === row.source_record_id))
    refs.unshift({ source_record_id: row.source_record_id, locator_json: '{}', role: 'source' });
  if (type === 'source')
    refs.unshift({
      source_record_id: id,
      locator_json: typeof row.locator_json === 'string' ? row.locator_json : null,
      role: 'original record',
    });
  return refs.map((ref) => {
    const source = db
      .prepare(
        `SELECT sr.*,sf.path,sf.sha256,sf.coverage_status,p.name AS issuer,ap.name AS acquisition FROM source_records sr JOIN source_files sf ON sf.id=sr.source_file_id LEFT JOIN providers p ON p.id=sr.provider_id LEFT JOIN providers ap ON ap.id=sf.provider_id WHERE sr.id=?`,
      )
      .get(ref.source_record_id) as CitationSourceRow | undefined;
    const extra = parsedRecord(row.extra_json);
    const fields = isRecord(extra.sourceFields) ? extra.sourceFields : {};
    const issuer =
      fields.source ||
      (['observation', 'medication', 'procedure', 'document', 'source'].includes(type) &&
      row.provider_id
        ? db.prepare('SELECT name FROM providers WHERE id=?').get(row.provider_id)?.name
        : null);
    return {
      id: ref.source_record_id,
      role: ref.role,
      sourceKey: source?.source_key,
      issuer,
      sourceRecordProvider: source?.issuer,
      authors: fields.author || null,
      acquisition: source?.acquisition,
      file: source?.path,
      sha256: source?.sha256,
      coverage: source?.coverage_status,
      locator: parse(ref.locator_json),
      sourceLocator: parse(source?.locator_json),
      date: source?.date_text,
    };
  });
}
function exportPerson(db: Database, input: NoteExportInput): string {
  if (['note', 'person'].includes(input.type))
    return recordOwner(db, input.type, input.id) || 'patient';
  return 'patient';
}
function record(
  db: Database,
  requestedType: unknown,
  requestedId: unknown,
  personId = 'patient',
): ExportRecord {
  if (!isExportRecordType(requestedType) || typeof requestedId !== 'string')
    throw new HttpError(400, 'INVALID_EXPORT', 'Unknown export record type.');
  let type = requestedType;
  let id = requestedId;
  // Stored note links retain their original kind. Export the accepted current
  // classification while keeping the original tuple on the originating note.
  const resolved = resolveClinicalReference(db, type, id);
  if (resolved) {
    type = resolved.kind;
    id = resolved.recordId;
  }
  if (
    type === 'source' &&
    !db.prepare('SELECT id FROM source_records WHERE id=?').get(id) &&
    db.prepare('SELECT id FROM source_files WHERE id=?').get(id)
  )
    type = 'source_file';
  let row = rowFor(db, type, id);
  if (
    (['observation', 'medication', 'procedure'].includes(type) && row.person_id !== personId) ||
    (type === 'document' && documentPersonId(row.extra_json) !== personId) ||
    (type === 'person' && id !== personId) ||
    (type === 'note' &&
      (row.kind === 'person'
        ? row.person_id !== personId
        : (parsedRecord(row.profile_json).recordOwnerPersonId || 'patient') !== personId))
  )
    throw new HttpError(
      400,
      'EXPORT_SUBJECT',
      'An export can contain clinical records and authored notes for only its selected person.',
    );
  if (type === 'person') {
    const note = db.prepare('SELECT id FROM notes WHERE person_id=?').get(id);
    if (note) return record(db, 'note', note.id, personId);
  }
  const result: ExportRecord = {
    key: `${type}:${id}`,
    type,
    id,
    title: row.title || row.label || row.display_name || row.source_key || row.path || id,
    date:
      row.event_date || row.effective_at || row.start_at || row.date_text || row.updated_at || null,
    archived: archived(db, type, id, row),
    row,
    citations: citations(db, type, id, row),
    attachments: ['note', 'person', 'observation', 'medication', 'procedure', 'document'].includes(
      type,
    )
      ? attachments(db, type, id)
      : [],
    ...(['observation', 'medication', 'procedure', 'document'].includes(type)
      ? {
          ownershipCorrections: ownershipCorrections(
            db,
            type as 'observation' | 'medication' | 'procedure' | 'document',
            id,
          ),
          fieldCorrections: fieldCorrections(row),
        }
      : {}),
  };
  if (type === 'note') {
    result.note = getNote(db, id);
    result.title = result.note.title;
  }
  if (type === 'source') {
    const raw = parsedRecord(row.raw_json);
    const data = isRecord(raw.data) ? raw.data : {};
    result.title =
      row.label || (typeof data.display === 'string' ? data.display : null) || result.title;
  }
  if (type === 'document') {
    const extra = parsedRecord(row.extra_json);
    const reviewed = isRecord(extra.historicalNote) ? extra.historicalNote : {};
    result.title = typeof reviewed.title === 'string' ? reviewed.title : result.title;
    result.date = typeof reviewed.eventDate === 'string' ? reviewed.eventDate : result.date;
  }
  if (type === 'medication') {
    result.currentUse =
      (db.prepare('SELECT * FROM medication_preferences WHERE medication_id=?').get(id) as
        MedicationPreference | undefined) || null;
    if (result.currentUse?.status === 'current' && !result.archived)
      result.date = result.currentUse.updated_at;
  }
  return result;
}
export function exportOptions(db: Database, value: unknown) {
  const input = inputRecord(value);
  const personId = exportPerson(db, input);
  const main = record(db, input.type, input.id, personId);
  if (
    !['note', 'document'].includes(main.type) ||
    (input.type === 'person' && main.note?.kind !== 'person')
  )
    throw new HttpError(400, 'INVALID_EXPORT', 'Start an export from a note.');
  const links = new Set(
    (main.note?.links || []).map((l) => `${l.resolvedTargetType || l.targetType}:${l.targetId}`),
  );
  const choices = [];
  for (const candidate of Object.keys(tables)) {
    if (!isExportRecordType(candidate)) continue;
    const type = candidate;
    const table = tables[type];
    if (type === 'person' || type === 'source') continue;
    for (const row of db
      .prepare(
        `SELECT * FROM ${table}${['observation', 'medication', 'procedure'].includes(type) ? ' WHERE person_id=?' : type === 'document' ? " WHERE COALESCE(json_extract(extra_json,'$.import.personId'),'patient')=?" : type === 'note' ? " WHERE kind<>'person' AND COALESCE(json_extract(profile_json,'$.recordOwnerPersonId'),'patient')=?" : ''} ORDER BY id`,
      )
      .all(
        ...(['observation', 'medication', 'procedure', 'document', 'note'].includes(type)
          ? [personId]
          : []),
      ) as unknown as ExportRow[]) {
      const key = `${type}:${row.id}`;
      if (key === main.key) continue;
      const extra = parsedRecord(row.extra_json);
      const reviewed =
        type === 'document' && isRecord(extra.historicalNote) ? extra.historicalNote : {};
      const rowId = typeof row.id === 'string' ? row.id : '';
      const preference: MedicationPreference | null =
        type === 'medication'
          ? ((db
              .prepare('SELECT status,updated_at FROM medication_preferences WHERE medication_id=?')
              .get(rowId) as MedicationPreference | undefined) ?? null)
          : null;
      const isCurrent = preference?.status === 'current' && !archived(db, type, rowId, row);
      choices.push({
        key,
        type,
        id: rowId,
        title:
          (typeof reviewed.title === 'string' ? reviewed.title : null) ||
          row.title ||
          row.label ||
          row.path ||
          rowId,
        date:
          (isCurrent ? preference.updated_at : null) ||
          (typeof reviewed.eventDate === 'string' ? reviewed.eventDate : null) ||
          row.event_date ||
          row.effective_at ||
          row.start_at ||
          row.updated_at ||
          null,
        archived: archived(db, type, rowId, row),
        kind: row.kind || null,
        topic: row.note_type || row.category || type,
        source: row.provider_id || 'personal',
        linked: links.has(key),
        current: isCurrent,
        history: type === 'test_type' || row.kind === 'person',
      });
    }
  }
  // Source links and people links remain explicitly selectable, including unresolved links.
  for (const link of main.note?.links || []) {
    const linkedType = link.resolvedTargetType || link.targetType;
    const type =
      linkedType === 'source' &&
      db.prepare('SELECT id FROM source_files WHERE id=?').get(link.targetId)
        ? 'source_file'
        : linkedType;
    const key = `${type}:${link.targetId}`;
    const existing = choices.find((c) => c.key === key);
    if (existing) {
      existing.linked = true;
      continue;
    }
    if (key === main.key) continue;
    let unavailable = link.missing;
    try {
      record(db, type, link.targetId, personId);
    } catch {
      unavailable = true;
    }
    choices.push({
      key,
      type,
      id: link.targetId,
      title: link.title,
      linked: true,
      archived: link.archived,
      missing: unavailable,
      topic: type,
      source: 'linked',
      date: null,
    });
  }
  const assetChoices = db
    .prepare(
      `SELECT a.id,a.original_name AS title,a.mime_type AS mimeType,a.sha256,a.bytes,at.owner_type AS ownerType,at.owner_id AS ownerId,at.event_date AS date,at.caption FROM attachments at JOIN assets a ON a.id=at.asset_id ORDER BY a.id,at.id`,
    )
    .all();
  return {
    noteVersion: main.note?.version ?? hash(main),
    choices,
    assets: assetChoices.filter((asset) => {
      try {
        record(db, asset.ownerType, asset.ownerId, personId);
        return true;
      } catch {
        return false;
      }
    }),
    noteTitle: main.title,
  };
}
function packetSelection(db: Database, input: NoteExportInput): NoteExportInput {
  const provider = input.mode === 'provider';
  const simple =
    provider ||
    [
      'includeLinked',
      'includeAttachments',
      'includeProcedures',
      'includePrescriptions',
      'includePatient',
      'noteIds',
    ].some((key) => Object.hasOwn(input, key));
  if (!simple) return input;
  const personId = exportPerson(db, input);
  const main = record(db, input.type, input.id, personId);
  const selected = new Set<string>(),
    assetIds = new Set<string>(),
    seeds: ExportRecord[] = [];
  const add = (type: unknown, id: unknown): ExportRecord => {
    const r = record(db, type, id, personId);
    if (r.key !== main.key) selected.add(r.key);
    return r;
  };
  if (main.note?.kind !== 'person') seeds.push(main);
  if (input.noteIds !== undefined && (!Array.isArray(input.noteIds) || input.noteIds.length > 2000))
    throw new HttpError(400, 'INVALID_EXPORT', 'Choose a list of notes.');
  for (const id of input.noteIds || []) {
    const r = record(db, 'note', id, personId);
    if (r.note?.kind === 'person')
      throw new HttpError(400, 'INVALID_EXPORT', 'Choose notes rather than people.');
    seeds.push(add('note', id));
  }
  const attached = (r: ExportRecord): void => {
    for (const a of r.attachments) assetIds.add(a.assetId);
  };
  for (const seed of seeds) {
    if (provider || input.includeAttachments) attached(seed);
    if (provider || input.includeLinked)
      for (const link of seed.note?.links || []) {
        const linked = add(link.targetType, link.targetId);
        if (provider || input.includeAttachments) attached(linked);
      }
  }
  for (const [type, table] of [
    ['procedure', 'procedures'],
    ['medication', 'medications'],
    ['observation', 'observations'],
    ['document', 'documents'],
  ] as const) {
    if (
      !provider &&
      !(type === 'procedure' && input.includeProcedures) &&
      !(type === 'medication' && input.includePrescriptions)
    )
      continue;
    const where =
      type === 'document'
        ? " WHERE COALESCE(json_extract(extra_json,'$.import.personId'),'patient')=? AND provider_id IN (SELECT id FROM providers WHERE lower(name) NOT LIKE '%personal%' AND lower(id) NOT IN ('personal','self'))"
        : ' WHERE person_id=?';
    for (const row of db
      .prepare(`SELECT id FROM ${table}${where} ORDER BY id`)
      .all(personId) as unknown as ExportRow[]) {
      if (typeof row.id !== 'string') continue;
      if (
        !provider &&
        type === 'medication' &&
        (db.prepare('SELECT status FROM medication_preferences WHERE medication_id=?').get(row.id)
          ?.status !== 'current' ||
          archived(db, type, row.id, row))
      )
        continue;
      const included = add(type, row.id);
      if (!provider && input.includeAttachments) attached(included);
    }
  }
  // Conditions, allergies, visits and immunizations have no normalized table yet.
  // An unrepresented assertion is safe to include only when its retained person
  // evidence identifies this one subject. A name in raw source JSON is not an
  // authority for packet membership.
  if (provider) {
    for (const row of db
      .prepare(
        `SELECT sr.id FROM source_records sr
      WHERE ${assertionBoundary.additional}
        AND ${assertionBoundary.singleOwner}
        AND EXISTS (SELECT 1 FROM evidence e WHERE e.entity_type='person' AND e.entity_id=? AND e.source_record_id=sr.id AND e.role='report_subject')
      ORDER BY sr.id`,
      )
      .all(personId))
      add('source', String(row.id));
  }
  return {
    ...input,
    normalizedSelection: true,
    selected: [...selected],
    assets: [...assetIds].filter(Boolean),
    includeArchived: true,
    from: null,
    to: null,
    trends: false,
    mode: provider ? 'provider' : 'brief',
  };
}
function patientInformation(db: Database, personId = 'patient'): PatientInformation {
  const fieldsToShare = [
    'fullName',
    'name',
    'pronouns',
    'birthDate',
    'deathDate',
    'lifeStatus',
    'phone',
    'email',
    'address',
    'bloodType',
    'bloodTypeSource',
    'bloodTypeUncertainty',
    'medicalHistory',
  ];
  const self = db
    .prepare(
      'SELECT p.display_name,n.profile_json FROM people p LEFT JOIN notes n ON n.person_id=p.id WHERE p.id=?',
    )
    .get(personId);
  const profile = parsedRecord(self?.profile_json);
  const details = Object.fromEntries(
    fieldsToShare.filter((k) => profile[k] !== undefined).map((k) => [k, profile[k]]),
  );
  const contacts: JsonRecord[] = [];
  const linkedContacts = new Set(
    personId === 'patient'
      ? []
      : (
          db
            .prepare(
              "SELECT target_id FROM note_links WHERE note_id=(SELECT id FROM notes WHERE person_id=?) AND target_type='person'",
            )
            .all(personId) as Array<{ target_id: string }>
        ).map((row) => row.target_id),
  );
  for (const row of db
    .prepare(
      "SELECT p.id,p.display_name,n.profile_json FROM people p JOIN notes n ON n.person_id=p.id WHERE p.id<>'patient' ORDER BY p.id",
    )
    .all() as unknown as Array<ExportRow & { id: string; display_name: string }>) {
    if (archived(db, 'person', row.id, row)) continue;
    const data = parsedRecord(row.profile_json),
      roles = (Array.isArray(data.tags) ? data.tags : []).filter(
        (t): t is string =>
          typeof t === 'string' &&
          ['Professional', 'Primary Care Provider', 'Emergency Contact'].includes(t),
      );
    if (roles.length && (personId === 'patient' || linkedContacts.has(row.id)))
      contacts.push({
        name: row.display_name,
        roles,
        ...Object.fromEntries(
          ['fullName', 'phone', 'email', 'schedulingUrl']
            .filter((k) => data[k])
            .map((k) => [k, data[k]]),
        ),
      });
  }
  return {
    name: typeof self?.display_name === 'string' ? self.display_name : 'Not recorded',
    details,
    contacts,
    ...(personId !== 'patient'
      ? {
          caregiver: {
            name: String(
              db.prepare("SELECT display_name FROM people WHERE id='patient'").get()
                ?.display_name || 'Name not recorded',
            ),
            role: 'caregiver' as const,
          },
        }
      : {}),
  };
}
function includedReadingGaps(
  db: Database,
  records: ExportRecord[],
): NoteExportSnapshot['readingGaps'] {
  const citations = new Set(
    records.flatMap((record) => record.citations.map((citation) => citation.id)),
  );
  const sourceFiles = new Set(
    records.filter((record) => record.type === 'source_file').map((record) => record.id),
  );
  for (const id of citations) {
    const row = db.prepare('SELECT source_file_id FROM source_records WHERE id=?').get(id) as
      { source_file_id?: string } | undefined;
    if (row?.source_file_id) sourceFiles.add(row.source_file_id);
  }
  const result: NoteExportSnapshot['readingGaps'] = [];
  const visited = new Set<string>();
  const pending = [...sourceFiles].sort();
  while (pending.length) {
    const sourceId = pending.shift()!;
    if (visited.has(sourceId)) continue;
    visited.add(sourceId);
    const row = db.prepare('SELECT details_json FROM source_files WHERE id=?').get(sourceId);
    if (!row) continue;
    const metadata = parsedRecord(row.details_json);
    // Accepted conversions cite a proposal; source/package children can also
    // point at a parent original. Follow retained pointers without guessing paths.
    if (typeof metadata.originalSourceFileId === 'string')
      pending.push(metadata.originalSourceFileId);
    const details = readStoredIntakeDetails(db, sourceId);
    if (!details) continue;
    if (typeof details.parentSourceFileId === 'string') pending.push(details.parentSourceFileId);
    const workflow = details.workflow as { plans?: IntakeExtractionPlan[] } | undefined;
    const plan = workflow?.plans?.find((entry) => entry.status === 'active');
    const gaps =
      plan?.units?.flatMap((unit) => {
        const kind = accountedUnitKind(
          { ...plan, batches: plan.batches || [] },
          { ...unit, attempts: unit.attempts || [] },
        );
        if (!unit.processingException && kind && kind !== 'unreadable') return [];
        return [
          {
            locator: unit.locator || unit.id,
            reason:
              unit.processingException?.reason ||
              (kind === 'unreadable' ? 'unreadable' : 'not yet read'),
          },
        ];
      }) || [];
    if (!plan || !plan.units?.length)
      gaps.push({
        locator: 'Retained original',
        reason: 'reading has not established page coverage',
      });
    for (const reference of plan?.index?.references || [])
      if (reference.status === 'capacity_exception')
        gaps.push({
          locator: reference.locator,
          reason: `capacity exception: ${reference.note || 'references were not indexed'}`,
        });
    if (gaps.length)
      result.push({
        sourceFileId: sourceId,
        filename: String(details.originalName || sourceId),
        gaps,
      });
  }
  result.sort((a, b) => a.sourceFileId.localeCompare(b.sourceFileId));
  return result;
}

export function exportSnapshot(
  db: Database,
  value: unknown,
  now = new Date().toISOString(),
): NoteExportSnapshot {
  let input = packetSelection(db, inputRecord(value));
  if (!['note', 'document', 'person'].includes(input.type))
    throw new HttpError(400, 'INVALID_EXPORT', 'Invalid export options.');
  input = { ...input, mode: input.mode || 'brief' };
  const personId = exportPerson(db, input);
  const main = record(db, input.type, input.id, personId);
  if ((main.note?.version ?? hash(main)) !== input.noteVersion)
    throw new HttpError(409, 'EXPORT_STALE', 'The note changed. Save and refresh the preview.');
  if (input.type === 'person' && input.mode !== 'provider')
    throw new HttpError(400, 'INVALID_EXPORT', 'Start a person packet in provider mode.');
  const selected: string[] = [];
  for (const key of [...new Set(input.selected || [])].sort()) {
    if (typeof key !== 'string')
      throw new HttpError(400, 'INVALID_EXPORT', 'Invalid selected record.');
    selected.push(key);
  }
  if (selected.length > (input.mode === 'provider' ? 100000 : 2000))
    throw new HttpError(400, 'INVALID_EXPORT', 'Select at most 2,000 records.');
  for (const date of [input.from, input.to])
    if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || dateNumber(date) === null))
      throw new HttpError(400, 'INVALID_EXPORT', 'Use a complete date for export filtering.');
  if (input.from && input.to && input.from > input.to)
    throw new HttpError(400, 'INVALID_EXPORT', 'The start date is after the end date.');
  const inRange = (r: ExportRecord): boolean =>
    (!input.from && !input.to) ||
    (dateNumber(r.date) !== null &&
      !/\b(year|month|unknown|approximate|season)\b/i.test(r.row.date_precision || '') &&
      (!input.from || r.date!.slice(0, 10) >= input.from) &&
      (!input.to || r.date!.slice(0, 10) <= input.to));
  const records = new Map<string, ExportRecord>();
  for (const key of selected) {
    const index = key.indexOf(':');
    const r = record(db, key.slice(0, index), key.slice(index + 1), personId);
    if (r.archived && !input.includeArchived)
      throw new HttpError(
        400,
        'ARCHIVED_EXPORT',
        'Enable archived material or remove the archived selection.',
      );
    if (!inRange(r) && r.type !== 'test_type')
      throw new HttpError(
        400,
        'EXPORT_DATE_SCOPE',
        'A selected record is outside the date range or has no recorded date.',
      );
    if (r.type === 'test_type') {
      for (const item of db
        .prepare(
          'SELECT id FROM observations WHERE test_type_id=? AND person_id=? ORDER BY effective_at,id',
        )
        .all(r.id, personId)) {
        const observation = record(db, 'observation', item.id, personId);
        if (inRange(observation) && (!observation.archived || input.includeArchived))
          records.set(observation.key, observation);
        if (records.size > (input.mode === 'provider' ? 100000 : 2000))
          throw new HttpError(
            400,
            'EXPORT_TOO_LARGE',
            'This history exceeds 2,000 records. Narrow the dates.',
          );
      }
    } else if (r.key !== main.key) records.set(r.key, r);
  }
  if (records.size > (input.mode === 'provider' ? 100000 : 2000))
    throw new HttpError(
      400,
      'EXPORT_TOO_LARGE',
      'This selection expands beyond 2,000 records. Narrow the dates or choose fewer histories.',
    );
  if ((input.assets?.length || 0) > 100)
    throw new HttpError(400, 'EXPORT_TOO_LARGE', 'Select at most 100 companion originals.');
  const allowedOwners = new Set(
    [main, ...records.values()].flatMap((r) => [
      r.key,
      ...(r.note?.personId ? [`person:${r.note.personId}`] : []),
    ]),
  );
  const assets: ExportAsset[] = [];
  for (const id of [...new Set(input.assets || [])].sort()) {
    if (typeof id !== 'string')
      throw new HttpError(400, 'INVALID_EXPORT', 'Invalid selected attachment.');
    const a = required(
      db.prepare('SELECT * FROM assets WHERE id=?').get(id) as ExportRow | undefined,
      'Selected attachment is unavailable in this profile.',
    );
    const owners = db
      .prepare('SELECT * FROM attachments WHERE asset_id=? ORDER BY id')
      .all(id) as unknown as ExportOwner[];
    const allowed = owners.filter(
      (owner) =>
        (!input.normalizedSelection ||
          allowedOwners.has(`${owner.owner_type}:${owner.owner_id}`)) &&
        (() => {
          try {
            record(db, owner.owner_type, owner.owner_id, personId);
            return true;
          } catch {
            return false;
          }
        })(),
    );
    if (
      (input.from || input.to) &&
      !allowed.some(
        (o) =>
          dateNumber(o.event_date) !== null &&
          (!input.from || o.event_date!.slice(0, 10) >= input.from) &&
          (!input.to || o.event_date!.slice(0, 10) <= input.to),
      )
    )
      throw new HttpError(
        400,
        'EXPORT_DATE_SCOPE',
        'A selected original has no attachment date within the selected range.',
      );
    if (!allowed.length) throw new HttpError(400, 'INVALID_EXPORT', 'Select an attached original.');
    if (
      !input.includeArchived &&
      allowed.every((o) =>
        archived(db, o.owner_type, o.owner_id, rowFor(db, o.owner_type, o.owner_id)),
      )
    )
      throw new HttpError(400, 'ARCHIVED_EXPORT', 'This attachment belongs to archived material.');
    assets.push({
      id,
      originalName: typeof a.original_name === 'string' ? a.original_name : id,
      mimeType: typeof a.mime_type === 'string' ? a.mime_type : null,
      bytes: typeof a.bytes === 'number' ? a.bytes : null,
      sha256: typeof a.sha256 === 'string' ? a.sha256 : null,
      contentUrl: `/api/assets/${encodeURIComponent(id)}/content`,
      owners: allowed,
    });
  }
  for (const r of records.values())
    if (r.type === 'source_file')
      assets.push({
        id: `source-file:${r.id}`,
        originalName:
          (typeof r.row.path === 'string' ? r.row.path.split('/').at(-1) : null) || r.id,
        mimeType: typeof r.row.mime_type === 'string' ? r.row.mime_type : null,
        bytes: typeof r.row.bytes === 'number' ? r.row.bytes : null,
        sha256: typeof r.row.sha256 === 'string' ? r.row.sha256 : null,
        contentUrl: `/api/sources/${encodeURIComponent(r.id)}/content`,
        owners: [],
      });
  for (let i = assets.length - 1; i >= 0; i--) {
    const first = assets.findIndex(
      (a) => a.sha256 && a.sha256 === assets[i].sha256 && a.bytes === assets[i].bytes,
    );
    if (first !== -1 && first !== i) {
      assets[first].owners.push(...assets[i].owners);
      assets[first].originalNames = [
        ...new Set([
          ...(assets[first].originalNames || [assets[first].originalName]),
          assets[i].originalName,
        ]),
      ];
      assets.splice(i, 1);
    }
  }
  if (assets.length > 100)
    throw new HttpError(
      400,
      'EXPORT_TOO_LARGE',
      'Select at most 100 companion originals, including source files.',
    );
  const self = db
    .prepare(
      'SELECT p.display_name,n.profile_json,n.version FROM people p LEFT JOIN notes n ON n.person_id=p.id WHERE p.id=?',
    )
    .get(personId);
  const selfFields = parsedRecord(self?.profile_json);
  const identity = {
    name: typeof self?.display_name === 'string' ? self.display_name : 'Name not recorded',
    birthDate: selfFields.birthDate || null,
    pronouns: selfFields.pronouns || null,
    version: self?.version || null,
  };
  const patient =
    input.mode === 'provider' || input.includePatient ? patientInformation(db, personId) : null;
  // Correction provenance is mandatory even when optional patient/contact
  // details are hidden from a brief. The profile user is always the actor.
  const actor =
    personId === 'patient'
      ? { name: 'the patient', role: 'patient' as const }
      : {
          name: String(
            db.prepare("SELECT display_name FROM people WHERE id='patient'").get()?.display_name ||
              'Name not recorded',
          ),
          role: 'caregiver' as const,
        };
  if (input.type === 'person') {
    main.row = { ...main.row, content: '', topics: '', raw_thoughts: '', profile_json: '{}' };
    if (!main.note)
      throw new HttpError(
        404,
        'INVALID_EXPORT',
        'The selected person note is unavailable in this profile.',
      );
    main.note = {
      ...main.note,
      content: '',
      topics: '',
      rawThoughts: '',
      person: {},
      profile: {},
      links: [],
      backlinks: [],
      attachments: [],
    };
    main.attachments = [];
  }
  const ranks: Partial<Record<ExportRecordType, number>> = {
    note: 0,
    medication: 1,
    procedure: 2,
    observation: 3,
    document: 4,
    source: 5,
    source_file: 6,
  };
  const rank = (type: ExportRecordType): number => ranks[type] ?? 7;
  const payload = {
    actor,
    unassignedRawAssertionsOmitted: input.mode === 'provider' && unassignedPacketAssertions(db),
    reportReview: packetReportReview(
      db,
      [main, ...records.values()].flatMap((record) =>
        record.citations.map((citation) => citation.id),
      ),
    ),
    patient,
    identity,
    main,
    records: [...records.values()].sort(
      (a, b) =>
        (input.mode === 'provider' ? rank(a.type) - rank(b.type) : a.type.localeCompare(b.type)) ||
        (a.date || '').localeCompare(b.date || '') ||
        a.key.localeCompare(b.key),
    ),
    assets,
    readingGaps: includedReadingGaps(db, [main, ...records.values()]),
    mode: input.mode ?? 'brief',
    trends: !!input.trends,
    scope: {
      from: input.from || null,
      to: input.to || null,
      includeArchived: !!input.includeArchived,
    },
    selection: selected,
  };
  if (JSON.stringify(payload).length > (input.mode === 'provider' ? 64_000_000 : 8_000_000))
    throw new HttpError(
      400,
      'EXPORT_TOO_LARGE',
      'Selected text is too large for a single export. Narrow the selection.',
    );
  return { ...payload, generatedAt: now, fingerprint: hash(payload) };
}

function pageReference(locator: unknown): string {
  if (!isRecord(locator)) return missing(locator);
  const pages = locator.pages ?? locator.page ?? locator.pageNumber ?? locator.page_number;
  if (pages !== undefined)
    return `Page${Array.isArray(pages) ? 's' : ''} ${Array.isArray(pages) ? pages.join(', ') : pages}`;
  const path = locator.path || locator.pointer || locator.line || locator.region;
  return path ? `Location ${missing(path)}` : 'Page not recorded';
}
function fields(rows: Array<readonly [unknown, unknown]>): string {
  return `<dl>${rows
    .map(
      ([label, value]) =>
        `<div><dt>${esc(
          String(label)
            .replace(/([a-z])([A-Z])/g, '$1 $2')
            .replace(/_/g, ' ')
            .replace(/^./, (c) => c.toUpperCase()),
        )}</dt><dd>${esc(missing(value))}</dd></div>`,
    )
    .join('')}</dl>`;
}
function content(r: ExportRecord, mode: ExportMode, confirmedBy: string): string {
  const row = r.row;
  if (
    r.type === 'note' &&
    row.kind === 'person' &&
    row.person_id === 'patient' &&
    mode === 'provider'
  )
    return '<p>Patient information and clinical history follow.</p>';
  if (r.type === 'note')
    return `${markdown(typeof row.content === 'string' ? row.content : null)}${row.topics ? '<h3>Topics and questions</h3>' + markdown(String(row.topics)) : ''}${row.raw_thoughts ? '<h3>Raw thoughts</h3>' + markdown(String(row.raw_thoughts)) : ''}${row.kind === 'person' ? '<h3>Selected personal / family history</h3>' + fields(Object.entries(parsedRecord(row.profile_json))) : ''}`;
  if (r.type === 'document')
    return `<div class="literal">${esc(row.text_content || 'No note text recorded.')}</div>`;
  if (r.type === 'observation')
    return fields([
      ['Date / precision', `${missing(row.effective_at)} / ${row.date_precision}`],
      ['Result', row.value_text],
      ['Units', row.unit],
      ['Reference range', reference(row.reference_json)],
      ['Source result status', row.status],
    ]);
  if (r.type === 'medication') {
    const assertion = parsedRecord(r.currentUse?.assertion_json);
    const confirmation: Array<readonly [unknown, unknown]> =
      mode === 'detailed'
        ? [['Personal assertion', r.currentUse?.assertion_json]]
        : r.currentUse
          ? [
              ['Confirmation statement', assertion.statement],
              [
                'Confirmed by',
                r.currentUse?.status === 'current'
                  ? confirmedBy.includes('(caregiver)')
                    ? confirmedBy
                    : assertion.author || confirmedBy
                  : assertion.author || assertion.actor,
              ],
              ['Confirmation basis', assertion.basis],
            ]
          : [];
    return fields([
      [
        'Personal prescription state',
        r.archived ? 'Archived' : r.currentUse?.status === 'current' ? 'Current' : 'Inactive',
      ],
      ['Personal confirmation date', r.currentUse?.updated_at],
      ...confirmation,
      ['Recorded dose', row.dose_text],
      ['Route', row.route],
      ['Frequency', row.frequency],
      ['Source prescription status (does not establish current use)', row.status],
      ['Source assertion kind', row.kind],
      ['Start', row.start_at],
      ['End', row.end_at],
    ]);
  }
  if (r.type === 'procedure')
    return fields([
      ['Date', row.effective_at],
      ['Source status', row.status],
      ['Recorded details', parse(row.extra_json)],
    ]);
  if (r.type === 'source') return `<pre>${esc(row.raw_json)}</pre>`;
  if (r.type === 'source_file')
    return `<p>Original file selected as a companion download; its contents are not embedded in this PDF.</p>${fields(
      [
        ['File', row.path],
        ['Type', row.mime_type],
        ['Coverage', row.coverage_status],
      ],
    )}`;
  return fields(Object.entries(row).filter(([key]) => !key.endsWith('_json')));
}
function provenance(r: ExportRecord): string {
  const extra = parsedRecord(r.row.profile_json),
    parsedExtra = parsedRecord(r.row.extra_json),
    sourceFields = isRecord(parsedExtra.sourceFields) ? parsedExtra.sourceFields : {};
  return r.type === 'note'
    ? `Personal note; ${r.note?.status === 'draft' ? 'DRAFT' : r.note?.status || ''}; revision ${r.note?.version}. Authorship: ${missing(extra.authorship || extra.attribution || extra.author)}${r.row.note_type ? '; ' + r.row.note_type : ''}.`
    : `Provider/source assertion. Author: ${missing(sourceFields.author)}. Issuer: ${missing(sourceFields.source || r.citations[0]?.issuer)}.`;
}
interface TrendPoint {
  id: string;
  date: string;
  value: number;
  display: string;
  time: number;
  label: string;
  unit: string;
}
function trendHtml(records: ExportRecord[]): string {
  const groups = new Map<string, TrendPoint[]>();
  let excluded = 0;
  for (const r of records.filter((r) => r.type === 'observation')) {
    const dto = observation(r.row as Parameters<typeof observation>[0]),
      point = chartPoint(dto),
      time = chartDate(dto);
    if (!point || time === null || typeof r.row.unit !== 'string') {
      excluded++;
      continue;
    }
    const key = `${r.row.test_type_id}|${r.row.unit}`;
    groups.set(key, [
      ...(groups.get(key) || []),
      { ...point, display: point.display ?? '', time, label: r.title, unit: r.row.unit },
    ]);
  }
  let html =
      '<h2>Simple trends in selected results</h2><p>Recorded values, grouped by identical test and unit. No unit conversion or clinical interpretation.</p>',
    shown = 0;
  for (const values of groups.values()) {
    if (values.length < 2) continue;
    shown++;
    values.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
    const minX = values[0].time,
      maxX = values.at(-1)!.time,
      minY = Math.min(...values.map((v) => v.value)),
      maxY = Math.max(...values.map((v) => v.value));
    const x = (v: TrendPoint) =>
        50 + (maxX === minX ? 250 : ((v.time - minX) / (maxX - minX)) * 500),
      y = (v: TrendPoint) => 150 - (maxY === minY ? 60 : ((v.value - minY) / (maxY - minY)) * 120);
    const uniqueTimes = new Set(values.map((v) => v.time)).size === values.length;
    html += `<div style="break-inside:avoid"><h3>${esc(values[0].label)} (${esc(values[0].unit)})</h3><svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Selected recorded values over time" viewBox="0 0 620 200" style="width:100%;height:auto"><title>Selected ${esc(values[0].label)} results</title><path d="M50 20V160H550" fill="none" stroke="#80929c"/><text x="44" y="30" text-anchor="end" font-size="11">${esc(maxY)}</text><text x="44" y="154" text-anchor="end" font-size="11">${esc(minY)}</text>${uniqueTimes ? `<polyline points="${values.map((v) => `${x(v)},${y(v)}`).join(' ')}" fill="none" stroke="#267e88" stroke-width="2"/>` : ''}${values.map((v) => `<circle cx="${x(v)}" cy="${y(v)}" r="4" fill="#267e88"><title>${esc(v.date)}: ${esc(v.display)}</title></circle>`).join('')}<text x="50" y="185" font-size="11">${esc(values[0].date.slice(0, 10))}</text><text x="550" y="185" text-anchor="end" font-size="11">${esc(values[values.length - 1].date.slice(0, 10))}</text></svg>${!uniqueTimes ? '<p>Values sharing a timestamp are shown as points; no sequence is inferred.</p>' : ''}<p class="meta">${values.map((v) => `${esc(v.date)}: ${esc(v.display)}`).join('; ')}</p></div>`;
  }
  if (!shown) html += '<p>No comparable series with at least two selected numeric results.</p>';
  if (excluded)
    html += `<p>${excluded} selected results are not plotted because their date, numeric value, status or unit is unsuitable. Their original assertions remain in the results above.</p>`;
  return html;
}
export const exportCss = `@page{size:Letter;margin:18mm 16mm 19mm}*{box-sizing:border-box}body{font:11pt/1.5 Arial,sans-serif;color:#19242c;max-width:760px;margin:28px auto;padding:0 20px}h1{font-size:26pt;line-height:1.15}h2{font-size:17pt;margin-top:26px;border-bottom:1px solid #b8c7cd;padding-bottom:5px}h3{font-size:12pt}h1,h2,h3{break-after:avoid}p,li{orphans:3;widows:3}a{color:inherit}small,.meta{font-size:9pt;color:#455860}dl div{display:flex;border-bottom:1px solid #e4e9eb;padding:4px 0}dt{font-weight:bold;flex:0 0 38%;padding-right:10px}dd{margin:0;overflow-wrap:anywhere}.result-table{table-layout:fixed;font-size:8pt}.result-table th:first-child{width:24%}.result-table th:nth-child(2){width:12%}.result-table th:nth-child(3){width:26%}.result-table th:nth-child(4){width:16%}.result-table th:last-child{width:22%}.result-table td{vertical-align:top}.assertion-table{table-layout:fixed;font-size:8pt}.assertion-table th:first-child{width:24%}.assertion-table th:nth-child(2){width:64%}.assertion-table th:last-child{width:12%}.assertion-table td{vertical-align:top}.source-table{table-layout:fixed;font-size:8pt}.source-table th:first-child{width:10%}.source-table th:nth-child(2){width:40%}.source-table th:last-child{width:50%}.source-table td{vertical-align:top}.clinical-table{table-layout:fixed}.clinical-table th:first-child{width:26%}.clinical-table th:nth-child(2){width:49%}.clinical-table th:last-child{width:25%}.clinical-table td{vertical-align:top}table{width:100%;border-collapse:collapse;font-size:9pt}th,td{padding:6px;border:1px solid #b8c7cd;text-align:left;overflow-wrap:anywhere}thead{display:table-header-group}tr{break-inside:avoid}pre,.literal{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}blockquote{border-left:3px solid #b8c7cd;padding-left:12px}img{max-width:100%}.citation{font-size:9pt;overflow-wrap:anywhere}.section{break-before:page}.badge{font-weight:bold;font-size:10pt}.scope{border:1px solid #b8c7cd;padding:12px} @media print{body{margin:0;max-width:none;padding:0}}`;
export function exportEvidence(snapshot: NoteExportSnapshot): JsonRecord {
  const citations: Array<Citation & { number: number }> = [],
    seen = new Set<string>();
  for (const r of [snapshot.main, ...snapshot.records])
    for (const citation of r.citations) {
      const key = hash(citation);
      if (seen.has(key)) continue;
      seen.add(key);
      citations.push({ number: citations.length + 1, ...citation });
    }
  const included = new Set(
    [snapshot.main, ...snapshot.records].flatMap((r) => [
      r.key,
      ...(r.note?.personId ? [`person:${r.note.personId}`] : []),
    ]),
  );
  const project = (record: ExportRecord): JsonRecord => {
    const { note, ...clinical } = record;
    const actorDisplay =
      snapshot.actor.role === 'caregiver' ? `${snapshot.actor.name} (caregiver)` : 'the patient';
    return {
      ...clinical,
      ...(clinical.fieldCorrections
        ? {
            fieldCorrections: clinical.fieldCorrections.map((correction) => ({
              ...correction,
              actorDisplay,
            })),
          }
        : {}),
      ...(note
        ? {
            links: (note.links || [])
              .filter((link) =>
                included.has(`${link.resolvedTargetType || link.targetType}:${link.targetId}`),
              )
              .map((link) => ({
                targetType: link.targetType,
                targetId: link.targetId,
                relation: link.relation,
                ...(link.resolvedTargetType && link.resolvedTargetType !== link.targetType
                  ? { resolvedTargetType: link.resolvedTargetType }
                  : {}),
              })),
          }
        : {}),
    };
  };
  return {
    format: 'circus-health-provider-evidence-v1',
    ...snapshot,
    omissionDisclosure: snapshot.unassignedRawAssertionsOmitted
      ? unassignedAssertionDisclosure
      : null,
    main: project(snapshot.main),
    records: snapshot.records.map(project),
    citationIndex: citations,
  };
}
export function exportHtml(snapshot: NoteExportSnapshot): string {
  const all = [snapshot.main, ...snapshot.records];
  const provider = snapshot.mode === 'provider';
  const refs: Citation[] = [],
    citationIds = new Map<string, number>();
  for (const r of all)
    for (const c of r.citations) {
      const key = hash(c);
      if (!citationIds.has(key)) {
        refs.push(c);
        citationIds.set(key, refs.length);
      }
    }
  const citationNumbers = (r: ExportRecord): number[] =>
    r.citations.map((c) => {
      const key = hash(c);
      if (!citationIds.has(key)) {
        refs.push(c);
        citationIds.set(key, refs.length);
      }
      return citationIds.get(key)!;
    });
  const correctedBy =
    snapshot.actor.role === 'caregiver' ? `${snapshot.actor.name} (caregiver)` : 'the patient';
  const correctionLabels = (r: ExportRecord): string =>
    (r.fieldCorrections || [])
      .map(
        (correction) =>
          `Corrected by ${esc(correctedBy)} on ${esc(correction.at.slice(0, 10))} — not from a provider. ` +
          `${correction.fromKind ? `Reclassified from ${esc(correction.fromKind)} to ${esc(correction.toKind)}. ` : ''}` +
          `Fields: ${correction.fields.map((field) => esc(field.replace(/([a-z])([A-Z])/g, '$1 $2'))).join(', ')}.` +
          `${correction.reason ? ` Reason: ${esc(correction.reason)}` : ''}`,
      )
      .join(' ');
  const ownershipLabel = (r: ExportRecord): string =>
    r.ownershipCorrections
      ?.map(
        (correction) =>
          `Owner corrected on ${esc(correction.at.slice(0, 10))} (${esc(({ move: 'moved', split: 'split from a shared record', link: 'linked to an existing record', unchanged: 'confirmed unchanged' } as const)[correction.action])}). Previously attributed to ${esc(correction.fromPersonName)}; corrected by ${esc(correctedBy)} as a patient-side assertion.${correction.reason ? ' Reason: ' + esc(correction.reason) : ''}`,
      )
      .join(' ') || '';
  const renderRecord = (r: ExportRecord, index: number, main = false): string => {
    const numbers = citationNumbers(r);
    return `<section id="record-${index}"><${main ? 'h1' : 'h3'}>${esc(r.title)}</${main ? 'h1' : 'h3'}><p class="meta">${esc(provenance(r))}${r.archived ? ' ARCHIVED.' : ''}<br>${snapshot.mode === 'detailed' ? 'Record ' + esc(r.key) + ' · ' : ''}${r.currentUse?.status === 'current' && !r.archived ? 'Personal confirmation date' : 'Date'}: ${esc(missing(r.date))}${numbers.length ? ' · Sources ' + numbers.map((n) => `[${n}]`).join(', ') : ' · Source citation not recorded.'}</p>${ownershipLabel(r) ? `<p class="meta">${ownershipLabel(r)}</p>` : ''}${correctionLabels(r) ? `<p class="meta">${correctionLabels(r)}</p>` : ''}${content(r, snapshot.mode, correctedBy)}</section>`;
  };
  const ownerCorrection = ownershipLabel;
  let body =
    `<p class="meta"><strong>${esc(snapshot.identity.name)}</strong>${snapshot.identity.birthDate ? ' · DOB ' + esc(snapshot.identity.birthDate) : ''}${snapshot.identity.pronouns ? ' · ' + esc(snapshot.identity.pronouns) : ''}</p>` +
    (provider && snapshot.main.note?.kind === 'person'
      ? `<h1>${esc(snapshot.identity.name)}</h1>`
      : renderRecord(snapshot.main, 0, true));
  body += provider
    ? `<div class="scope"><strong>New provider packet</strong><p>Prepared ${esc(snapshot.generatedAt.slice(0, 10))}. ${snapshot.records.length} clinical and selected-note entries, with ${snapshot.assets.length} accompanying originals.</p><p>Includes recorded history and selected notes. Missing, unreviewed and conflicting assertions remain labeled as recorded. This is not a complete hospital chart. Originals are separate accompanying downloads. Full indexed provenance, raw assertions and structured source documents are preserved in the automatic evidence JSON companion.</p></div>`
    : snapshot.mode === 'brief'
      ? `<p class="meta">Appointment brief · Generated ${esc(snapshot.generatedAt.slice(0, 10))} · ${snapshot.records.length} selected supplements. Date scope: ${esc(snapshot.scope.from || 'any')} to ${esc(snapshot.scope.to || 'any')}. This note and explicitly selected evidence.</p>`
      : `<div class="scope"><strong>${snapshot.mode === 'detailed' ? 'Detailed evidence packet' : 'New provider packet'}${provider ? ' · clinical archive and selected notes' : ' · selected evidence only'}</strong><p>Generated ${esc(snapshot.generatedAt)}. Date scope: ${esc(snapshot.scope.from || 'unbounded')} to ${esc(snapshot.scope.to || 'unbounded')}. Archived supplements: ${snapshot.scope.includeArchived ? 'allowed when selected' : 'excluded'}. ${snapshot.records.length} supplementary records and ${snapshot.assets.length} companion originals selected.</p><p>This is not a complete hospital chart. Missing, unreviewed and conflicting assertions are retained as recorded. No clinical recommendations or medication reconciliation are inferred. Original assets are companion downloads, not embedded pages.</p></div>`;
  if (provider && snapshot.unassignedRawAssertionsOmitted)
    body += `<section><h2>Records with unverified ownership</h2><p>${esc(unassignedAssertionDisclosure)}</p></section>`;
  const partialReports = snapshot.reportReview.filter(
    (report) => report.savedCount < report.totalCount,
  );
  if (partialReports.length)
    body += `<section><h2>Partly reviewed reports</h2>${partialReports.map((report) => `<p><strong>${esc(report.title)}</strong>: ${report.savedCount} of ${report.totalCount} current report items reviewed and saved. Remaining items are not accepted clinical records. These counts describe review of the source report, not how many items are included in this packet.</p>`).join('')}</section>`;
  if (snapshot.readingGaps.length)
    body += `<section><h2>Unread source sections</h2><p>These source sections were not fully read. An absent finding in this packet does not establish absence in the original.</p>${snapshot.readingGaps.map((source) => `<h3>${esc(source.filename)}</h3><ul>${source.gaps.map((gap) => `<li>${esc(gap.locator)}: ${esc(gap.reason)}</li>`).join('')}</ul>`).join('')}</section>`;
  if (snapshot.mode === 'detailed')
    body += `<section class="section"><h2>Contents and overview</h2><ol><li>Main note: ${esc(snapshot.main.title)}</li>${snapshot.records.map((r, i) => `<li><a href="#record-${i + 1}">${esc(r.type)}: ${esc(r.title)}</a></li>`).join('')}<li><a href="#sources">Sources and companion originals</a></li></ol><h2>Selected chronology</h2>${fields([...all].sort((a, b) => (a.date || '').localeCompare(b.date || '')).map((r) => [missing(r.date), `${r.title} (${r.key})`]))}</section>`;
  if (snapshot.patient)
    body += `<section><h2>Patient information</h2>${fields([['Name', snapshot.patient.name], ...Object.entries(snapshot.patient.details).filter(([key]) => key !== 'name')])}${snapshot.patient.caregiver ? `<h3>Caregiver</h3>${fields(Object.entries(snapshot.patient.caregiver))}` : ''}<h3>Care and emergency contacts</h3>${snapshot.patient.contacts.length ? snapshot.patient.contacts.map((c) => fields(Object.entries(c))).join('') : '<p>Not recorded.</p>'}</section>`;
  if (provider) {
    const current = snapshot.records.filter(
      (r) => r.type === 'medication' && r.currentUse?.status === 'current' && !r.archived,
    );
    body += `<section><h2>Current prescriptions</h2>${current.length ? fields(current.map((r) => [r.title, `${missing(r.row.dose_text)}; confirmed by ${correctedBy} on ${missing(r.currentUse?.updated_at)}`])) : '<p>No personally confirmed current prescriptions recorded. This does not establish that none are taken.</p>'}<p>Historical orders and source statuses follow below; they do not establish current use. Allergies, diagnoses and visits may appear in provider notes or additional retained clinical assertions; absence of a separate summary is not evidence of absence.</p></section>`;
  }
  if (provider)
    body += `<section><h2>Included clinical records</h2><p>Includes normalized patient clinical entries, known provider documents and additional retained clinical assertions. Personal-source and unknown-provider documents are included only when directly linked from a selected note. Other personal notes are not included.</p>${fields(Object.entries(snapshot.records.reduce<Record<string, number>>((counts, r) => ({ ...counts, [r.type]: (counts[r.type] || 0) + 1 }), {})))}</section>`;
  const compactClinical = (entries: ExportRecord[]): string => {
    const type = entries[0]!.type;
    const heading = (
      { observation: 'Result', medication: 'Prescription', procedure: 'Procedure' } as const
    )[type as 'observation' | 'medication' | 'procedure'];
    if (type === 'observation') {
      const groups = new Map<string, ExportRecord[]>();
      for (const r of entries) {
        const key = `${r.row.test_type_id}|${r.row.unit || ''}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(r);
      }
      return [...groups.values()]
        .map((group) => {
          const precisions = [...new Set(group.map((r) => missing(r.row.date_precision)))];
          return `<h3>${esc(group[0].title)}${group[0].row.unit ? ' · ' + esc(group[0].row.unit) : ''}</h3><table class="result-table"><thead><tr><th colspan="5">${esc(group[0].title)}${group[0].row.unit ? ' · ' + esc(group[0].row.unit) : ''}<br>Date precision: ${precisions.map((p, i) => `${precisions.length > 1 ? 'P' + (i + 1) + ': ' : ''}${esc(p)}`).join('; ')}</th></tr><tr><th>Date / precision</th><th>Result</th><th>Reference</th><th>Status</th><th>Sources</th></tr></thead><tbody>${group
            .map(
              (r) =>
                `<tr id="record-${snapshot.records.indexOf(r) + 1}"><td>${esc(missing(r.date))}${precisions.length > 1 ? '<br>P' + (precisions.indexOf(missing(r.row.date_precision)) + 1) : ''}</td><td>${String(r.row.value_text).length > 160 ? 'Narrative below' : esc(r.row.value_text)}${correctionLabels(r) ? '<br>' + correctionLabels(r) : ''}</td><td>${esc(missing(reference(r.row.reference_json)))}</td><td>${esc(missing(r.row.status))}${r.archived ? '; archived' : ''}${ownerCorrection(r) ? '<br>' + ownerCorrection(r) : ''}</td><td>${
                  citationNumbers(r)
                    .map((n) => `[${n}]`)
                    .join(' ') || 'Not recorded'
                }</td></tr>${String(r.row.value_text).length > 160 ? `<tr><td colspan="5"><div class="literal">${esc(r.row.value_text)}</div></td></tr>` : ''}`,
            )
            .join('')}</tbody></table>`;
        })
        .join('');
    }
    return `<table class="clinical-table"><thead><tr><th>${heading} / date</th><th>Recorded information</th><th>Status / sources</th></tr></thead><tbody>${entries
      .map((r) => {
        const row = r.row,
          numbers = citationNumbers(r);
        let details = '';
        if (type === 'medication')
          details = `${esc(missing(row.dose_text))}<br>Route: ${esc(missing(row.route))}; frequency: ${esc(missing(row.frequency))}<br>Start: ${esc(missing(row.start_at))}; end: ${esc(missing(row.end_at))}${r.currentUse?.status === 'current' ? `<br>Confirmed by ${esc(correctedBy)} on ${esc(missing(r.currentUse.updated_at))}; full assertion in evidence companion` : ''}`;
        if (type === 'procedure') {
          const extra = parsedRecord(row.extra_json),
            sourceFields = isRecord(extra.sourceFields) ? extra.sourceFields : {},
            clinical = {
              ...Object.fromEntries(
                Object.entries(extra).filter(
                  ([key]) =>
                    !['sourceFields', 'mapping', 'reviewBatch', 'classificationBasis'].includes(
                      key,
                    ),
                ),
              ),
              ...Object.fromEntries(
                Object.entries(sourceFields).filter(
                  ([key]) => !['links', 'display', 'source', 'status', 'performed'].includes(key),
                ),
              ),
            };
          details =
            Object.entries(clinical)
              .map(([key, value]) => `${esc(key)}: ${esc(missing(value))}`)
              .join('; ') ||
            'No additional clinical fields recorded. Full source and mapping metadata in evidence companion.';
        }
        const status =
          type === 'medication'
            ? `Personal state: ${r.archived ? 'Archived' : r.currentUse?.status === 'current' ? 'Current' : 'Inactive'}<br>Source status: ${esc(missing(row.status))}<br>Source kind: ${esc(missing(row.kind))}`
            : esc(missing(row.status));
        return `<tr id="record-${snapshot.records.indexOf(r) + 1}"><td><strong>${esc(r.title)}</strong><br>${esc(missing(r.date))}</td><td>${details}${correctionLabels(r) ? '<br>' + correctionLabels(r) : ''}</td><td>${status}${r.archived ? '<br>Archived' : ''}<br>${numbers.length ? 'Sources ' + numbers.map((n) => `[${n}]`).join(', ') : 'Source citation not recorded'}${ownerCorrection(r) ? '<br>' + ownerCorrection(r) : ''}</td></tr>`;
      })
      .join('')}</tbody></table>`;
  };
  let lastType = '';
  const renderedClinical = new Set<ExportRecordType>(),
    narrativeGroups = new Map<string, ExportRecord[]>();
  if (provider)
    for (const r of snapshot.records.filter((r) => r.type === 'document')) {
      const key = typeof r.row.text_content === 'string' ? r.row.text_content : '';
      if (!key) continue;
      if (!narrativeGroups.has(key)) narrativeGroups.set(key, []);
      narrativeGroups.get(key)!.push(r);
    }
  const renderedNarratives = new Set<string>();
  snapshot.records.forEach((r, index) => {
    if (provider && ['observation', 'medication', 'procedure'].includes(r.type)) {
      if (renderedClinical.has(r.type)) return;
      renderedClinical.add(r.type);
      body +=
        `<h2>${esc(({ observation: 'Laboratory and measurement history', medication: 'Prescription history', procedure: 'Procedure history' } as const)[r.type as 'observation' | 'medication' | 'procedure'])}</h2>` +
        compactClinical(snapshot.records.filter((item) => item.type === r.type));
      return;
    }
    if (provider && r.type === 'source') {
      if (renderedClinical.has('source')) return;
      renderedClinical.add('source');
      body += `<h2>Additional retained clinical assertions</h2><p>Recorded fields below are copied without interpretation. Full raw objects, including operational links and capture metadata, are in the evidence JSON companion.</p><table class="assertion-table"><thead><tr><th>Entry / date</th><th>Recorded clinical fields</th><th>Sources</th></tr></thead><tbody>${snapshot.records
        .filter((item) => item.type === 'source')
        .map((item) => {
          const raw = parsedRecord(item.row.raw_json),
            data = isRecord(raw.data) ? raw.data : raw;
          const details = Object.entries(data)
            .filter(([key]) => !['links', 'captured_via', 'id', 'display'].includes(key))
            .map(
              ([key, value]) =>
                `<strong>${esc(key.replace(/([a-z])([A-Z])/g, '$1 $2'))}:</strong> ${esc(missing(value))}`,
            )
            .join('; ');
          return `<tr><td>${esc(item.title)}<br>${esc(missing(item.date))}</td><td>${details || 'See original object in evidence companion.'}</td><td>${
            citationNumbers(item)
              .map((n) => `[${n}]`)
              .join(' ') || 'Not recorded'
          }</td></tr>`;
        })
        .join('')}</tbody></table>`;
      return;
    }
    if (provider && r.type === 'document' && r.row.text_content) {
      const structured = parse(r.row.text_content, null);
      if (structured && typeof structured === 'object') {
        body += `<p><strong>${esc(r.title)}</strong> · ${esc(missing(r.date))} · Sources ${citationNumbers(
          r,
        )
          .map((n) => `[${n}]`)
          .join(
            ', ',
          )}. Structured source document retained in full in the evidence JSON companion; normalized clinical entries are above. ${ownerCorrection(r)} ${correctionLabels(r)}</p>`;
        return;
      }
      if (renderedNarratives.has(r.row.text_content)) return;
      renderedNarratives.add(r.row.text_content);
      const group = narrativeGroups.get(r.row.text_content)!;
      if (group.length > 1) {
        body += `<h2>${esc(r.title)}</h2><p>Identical narrative retained once below. Recorded in ${group.length} entries:</p><ul>${group
          .map(
            (item) =>
              `<li>${esc(item.title)} · ${esc(missing(item.date))} · ${esc(provenance(item))} · ${ownerCorrection(item)} ${correctionLabels(item)} · Sources ${
                citationNumbers(item)
                  .map((n) => `[${n}]`)
                  .join(', ') || 'not recorded'
              }</li>`,
          )
          .join('')}</ul><div class="literal">${esc(r.row.text_content)}</div>`;
        return;
      }
    }
    if (r.type !== lastType) {
      const headings: Partial<Record<ExportRecordType, string>> = {
        note: 'Selected notes and personal / family history',
        document: 'Provider notes',
        source: 'Additional retained clinical assertions',
        source_file: 'Selected original files',
      };
      body += `<h2${snapshot.mode === 'detailed' ? ' class="section"' : ''}>${esc(headings[r.type] || r.type)}</h2>`;
      lastType = r.type;
    }
    body += renderRecord(r, index + 1);
  });
  if (snapshot.trends) body += trendHtml(snapshot.records);
  const providerSources = () =>
    `<p>The accompanying <strong>provider-evidence.json</strong> contains all ${refs.length} indexed citations. Match each [number] above to its citationIndex entry for issuer, acquisition provider, original file path/hash, exact locator and coverage. It also contains every included record with original assertions, full source JSON and structured document text. Download and share it with this PDF when full supporting detail is needed.</p><p>Sources represented: ${[...new Set(refs.map((c) => c.issuer || c.sourceRecordProvider || c.acquisition).filter(Boolean))].map(esc).join('; ') || 'Not recorded'}.</p>`;
  body += `<section id="sources" class="${snapshot.mode === 'detailed' ? 'section' : ''}"><h2>Sources and companion originals</h2>${provider && refs.length ? providerSources() : refs.length ? refs.map((c, i) => `<p class="citation">[${i + 1}] ${snapshot.mode === 'detailed' ? `Source record ${esc(c.id)}; source key ${esc(missing(c.sourceKey))}. ` : ''}Issuer: ${esc(missing(c.issuer))}; acquisition source: ${esc(missing(c.acquisition))}.${snapshot.mode === 'detailed' ? ' Source-record provider: ' + esc(missing(c.sourceRecordProvider)) + '.' : ''} File: ${esc(missing(c.file))}${snapshot.mode === 'detailed' ? '; SHA-256: ' + esc(missing(c.sha256)) : ''}. Evidence locator / PDF pages: ${esc(snapshot.mode === 'detailed' ? missing(c.locator) : pageReference(c.locator))}; original locator: ${esc(snapshot.mode === 'detailed' ? missing(c.sourceLocator) : pageReference(c.sourceLocator))}. Coverage: ${esc(missing(c.coverage))}; source date: ${esc(missing(c.date))}.</p>`).join('') : '<p>No external source citations recorded for the selected content.</p>'}${snapshot.assets.map((a) => `<p class="citation">Companion original: ${esc(a.originalName)} (${esc(a.mimeType)}, ${a.bytes} bytes).${snapshot.mode === 'detailed' ? ' Asset ' + esc(a.id) + '; SHA-256 ' + esc(a.sha256) + '.' : ''} Download separately from the preview; not embedded in this PDF.</p>`).join('')}<p class="citation">${snapshot.mode === 'detailed' ? 'Snapshot SHA-256: ' + esc(snapshot.fingerprint) + '. ' : ''}Note revision: ${esc(snapshot.main.note?.version || snapshot.fingerprint)}. ${snapshot.mode === 'detailed' ? 'Supplement versions and original assertions preserved by the snapshot fingerprint; source locators reproduced as recorded.' : 'Selected saved content; missing source information is labeled above.'}</p></section>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><title>Circus Health · ${esc(snapshot.main.title)}</title><style>${exportCss}</style></head><body>${body}</body></html>`;
}
export async function exportPdf(html: string): Promise<Buffer> {
  const { chromium } = await import('playwright');
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch {
    throw new HttpError(
      503,
      'PDF_RENDERER_UNAVAILABLE',
      'The PDF renderer could not start. In the supported Docker deployment, Chromium is included: check temporary/shared-memory space and process limits, then rebuild the application image and retry.',
    );
  }
  try {
    const page = await browser.newPage();
    await page.route('**/*', (route) => route.abort());
    await page.setContent(html, { waitUntil: 'load' });
    return await page.pdf({
      format: 'Letter',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate:
        '<div style="font-size:8px;width:100%;text-align:center;color:#555">Circus Health · Selected health evidence · Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>',
      margin: { top: '18mm', bottom: '19mm', left: '16mm', right: '16mm' },
    });
  } finally {
    await browser.close();
  }
}
export function createNoteExports() {
  const snapshots = new Map<string, SnapshotEntry>();
  return async ({
    resource,
    id,
    action,
    method,
    req,
    res,
    db,
    profileId,
    respond,
    jsonBody,
  }: NoteExportRouteContext): Promise<boolean> => {
    if (resource !== 'note-exports') return false;
    const now = Date.now();
    for (const [key, entry] of snapshots) if (entry.expires < now) snapshots.delete(key);
    if (method === 'POST' && id === 'options') {
      respond(exportOptions(db, await jsonBody(req)));
      return true;
    }
    if (method === 'POST' && id === 'preview') {
      const input = inputRecord(await jsonBody(req)),
        snapshot = exportSnapshot(db, input),
        token = randomUUID();
      if (snapshots.size >= 30) {
        const oldest = snapshots.keys().next().value;
        if (oldest) snapshots.delete(oldest);
      }
      snapshots.set(token, { profileId, input, snapshot, expires: now + 30 * 60 * 1000 });
      respond({
        token,
        html: exportHtml(snapshot),
        fingerprint: snapshot.fingerprint,
        generatedAt: snapshot.generatedAt,
        assets: snapshot.assets,
        evidenceAvailable: snapshot.mode === 'provider',
      });
      return true;
    }
    if (method === 'POST' && id && action && ['validate', 'pdf', 'evidence'].includes(action)) {
      const entry = snapshots.get(id);
      if (!entry || entry.profileId !== profileId)
        throw new HttpError(
          404,
          'EXPORT_EXPIRED',
          'Preview expired or is unavailable in this profile. Refresh the preview.',
        );
      if (exportSnapshot(db, entry.input).fingerprint !== entry.snapshot.fingerprint)
        throw new HttpError(
          409,
          'EXPORT_STALE',
          'Selected content changed after preview. Refresh the preview.',
        );
      if (action === 'validate') respond({ valid: true });
      else if (action === 'evidence') {
        if (entry.snapshot.mode !== 'provider')
          throw new HttpError(
            400,
            'INVALID_EXPORT',
            'Evidence companions belong to provider packets.',
          );
        const content = JSON.stringify(exportEvidence(entry.snapshot), null, 2);
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Disposition': 'attachment; filename="provider-evidence.json"',
          'Cache-Control': 'no-store',
        });
        res.end(content);
      } else {
        const pdf = await exportPdf(exportHtml(entry.snapshot));
        if (exportSnapshot(db, entry.input).fingerprint !== entry.snapshot.fingerprint)
          throw new HttpError(
            409,
            'EXPORT_STALE',
            'Selected content changed while preparing the PDF. Refresh the preview.',
          );
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Disposition': 'attachment; filename="note-export.pdf"',
          'Cache-Control': 'no-store',
        });
        res.end(pdf);
      }
      return true;
    }
    throw new HttpError(404, 'NOT_FOUND', 'Export action not found.');
  };
}
