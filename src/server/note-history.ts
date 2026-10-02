import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { HttpError, json, now, revision, type Database, type SqliteRow } from './database.ts';
import type { SQLInputValue } from 'node:sqlite';
import { getNote, saveNote, target } from './notes.ts';
import { profileFile } from './assets.ts';
import {
  recordDurabilityStatus,
  queryRecordHistory,
  readIndexedRecordVersion,
  type DurableRecordVersion,
  type RecordFieldChange,
} from './record-versions.ts';
import { personalDurabilityStatus, publishedPersonalLineage } from './portable.ts';

const OP_PREFIX = 'personal_restore_';
type JsonObject = Record<string, unknown>;
type TextFormats = Record<string, string>;
interface NoteRecord extends JsonObject {
  id: string;
  kind: string;
  isSelf: boolean;
  status: string;
  title: string;
  content: unknown;
  textFormats: TextFormats;
  pinned: boolean;
  typeLabel: unknown;
  eventDate: unknown;
  topics: unknown;
  rawThoughts: unknown;
  personId?: string | null;
  person: JsonObject;
  version: number;
}
interface SnapshotNoteRow extends SqliteRow {
  id: string;
  kind: string;
  status: string;
  title: string;
  content: string;
  text_formats_json: string;
  pinned: number;
  note_type: string | null;
  event_date: string | null;
  topics: string;
  raw_thoughts: string;
  profile_json: string;
  person_id: string | null;
  version: number;
}
interface SnapshotValue {
  createdAt?: string;
  revision?: number;
  history?: { previous?: unknown };
  restoreOperations?: Array<{ key: string }>;
  tables: {
    notes?: SnapshotNoteRow[];
    people?: Array<SqliteRow & { id: string; display_name: string }>;
    note_links?: Array<SqliteRow & { note_id: string }>;
    attachments?: Array<
      SqliteRow & { owner_type: string; owner_id: string; person_id?: string | null }
    >;
  };
}
interface PublishedGeneration {
  manifest: { file: string };
  value: SnapshotValue;
}
export interface HistoryCell {
  present: boolean;
  value?: unknown;
  format?: string;
}
interface FieldComparison {
  path: string;
  label: string;
  previous: HistoryCell;
  current: HistoryCell;
  changed: boolean;
  restorable: boolean;
}
interface RestoreInput extends JsonObject {
  operationId?: unknown;
  fields?: unknown;
  associations?: unknown;
  generationId?: unknown;
  version?: unknown;
  expectedRevision?: unknown;
  previewToken?: unknown;
  request?: unknown;
}
interface RestoreOperation extends JsonObject {
  operationId: string;
  noteId: string;
  fingerprint: string;
}
interface AssociationRow extends SqliteRow {
  id: string;
  asset_id: string;
  owner_type: string;
  owner_id: string;
  caption: string;
  body_location: string | null;
  event_date: string | null;
  person_id: string | null;
  target_type: Parameters<typeof target>[1];
  target_id: string;
  relation: string;
}
interface AssociationDiff extends JsonObject {
  id: string;
  restorable: boolean;
  reason: string | null;
}
interface NormalizedSelection {
  fields: string[];
  associations: { links: string[]; attachments: string[] };
}
type AssociationKind = keyof NormalizedSelection['associations'];
interface IndexedHistoryEntry extends JsonObject {
  generationId: string;
  operationId: string;
  sessionId: string | null;
  savedAt: string;
}
interface HistoryGroup extends JsonObject {
  id: string;
  key: string;
  sessionId: string | null;
  label: string;
  savedAt: string;
  entries: string[];
}
interface RestorationPreview extends NormalizedSelection, JsonObject {
  noteId: string;
  generationId: string;
  version: number;
  expectedRevision: number;
  changes: Array<{
    path: string;
    label: string;
    before: HistoryCell;
    after: HistoryCell;
  }>;
  associationChanges: AssociationDiff[];
  restoredFrom: string[];
  previewToken: string;
}
interface RestorationPlan {
  current: NoteRecord;
  old: NoteRecord;
  rows: Record<AssociationKind, AssociationRow[]>;
  preview: RestorationPreview;
}
type SaveNoteForHistory = (
  db: Database,
  id: string,
  payload: JsonObject,
  afterSave: (saved: NoteRecord) => void,
) => NoteRecord;
const PERSON_FIELDS = [
  'icon',
  'name',
  'fullName',
  'pronouns',
  'relationship',
  'birthDate',
  'deathDate',
  'lifeStatus',
  'medicalHistory',
  'bloodType',
  'bloodTypeUncertainty',
  'tags',
  'phone',
  'email',
  'schedulingUrl',
];
const LABELS = {
  icon: 'Person icon',
  title: 'Title',
  content: 'Content',
  pinned: 'Pinned',
  typeLabel: 'Type',
  eventDate: 'Event date',
  topics: 'Topics & questions',
  rawThoughts: 'Raw thoughts',
  name: 'Display name',
  fullName: 'Full name',
  pronouns: 'Pronouns',
  relationship: 'Relationship',
  birthDate: 'Date of birth',
  deathDate: 'Date of death',
  lifeStatus: 'Life status',
  medicalHistory: 'Medical / family history',
  bloodType: 'Blood type',
  bloodTypeUncertainty: 'Blood type uncertainty',
  tags: 'Tags',
  phone: 'Phone',
  email: 'Email',
  schedulingUrl: 'Scheduling URL',
};
const has = (object: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(object, key);
function checkOwner(db: Database, profileId: string): void {
  if (
    db.prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'").get()?.value !== profileId
  )
    throw new HttpError(404, 'NOT_FOUND', 'Profile history not found');
}
function fieldsFor(note: NoteRecord): string[] {
  return [
    'content',
    'pinned',
    ...(note.kind === 'person'
      ? PERSON_FIELDS.filter((field) => !(note.isSelf && field === 'relationship')).map(
          (field) => 'person.' + field,
        )
      : [
          'title',
          ...(note.kind === 'historical'
            ? ['typeLabel', 'eventDate', 'topics', 'rawThoughts']
            : []),
        ]),
  ];
}
function cell(note: NoteRecord, field: string): HistoryCell {
  const personField = field.startsWith('person.') ? field.slice(7) : null;
  const object: JsonObject = personField ? note.person : note;
  const key = personField || field;
  if (personField === 'name' && !has(object, key)) return { present: true, value: note.title };
  const formatKey =
    field === 'person.medicalHistory'
      ? 'medicalHistory'
      : ['content', 'topics', 'rawThoughts'].includes(field)
        ? field
        : null;
  const format = formatKey ? { format: note.textFormats?.[formatKey] || 'plain-v1' } : {};
  return has(object, key)
    ? { present: true, value: object[key], ...format }
    : { present: false, ...format };
}
const sameCell = (left: HistoryCell, right: HistoryCell): boolean =>
  JSON.stringify(left) === JSON.stringify(right);
function fromSnapshot(value: SnapshotValue, noteId: string): NoteRecord | null {
  const row = value.tables.notes?.find((note) => note.id === noteId);
  if (!row) return null;
  const person = json(row.profile_json, {}) as JsonObject;
  const display = row.person_id
    ? value.tables.people?.find((person) => person.id === row.person_id)?.display_name
    : null;
  const isSelf = row.kind === 'person' && row.person_id === 'patient';
  const note = {
    id: row.id,
    kind: row.kind,
    isSelf,
    status: row.status,
    title: display || row.title,
    content: row.content,
    textFormats: json(row.text_formats_json, {}) as TextFormats,
    pinned: Boolean(row.pinned),
    typeLabel: row.note_type,
    eventDate: row.event_date,
    topics: row.topics,
    rawThoughts: row.raw_thoughts,
    person: { ...person, ...(display ? { name: display } : {}) },
    version: row.version,
  };
  return note;
}
function fieldDiff(current: NoteRecord, previous: NoteRecord): FieldComparison[] {
  return fieldsFor(current).map((path) => {
    const before = cell(previous, path),
      after = cell(current, path);
    return {
      path,
      label: LABELS[path.replace(/^person\./, '') as keyof typeof LABELS],
      previous: before,
      current: after,
      changed: !sameCell(before, after),
      restorable:
        current.status !== 'finished' &&
        !(current.isSelf && path === 'person.tags') &&
        (before.present || path.startsWith('person.')),
    };
  });
}
function historyError(error: unknown): HttpError {
  return error instanceof HttpError
    ? error
    : new HttpError(
        409,
        'HISTORY_UNAVAILABLE',
        'Verified history could not be read. The existing saved entry is unchanged.',
      );
}
export function noteHistory(
  db: Database,
  root: string,
  profileId: string,
  id: string,
  params: URLSearchParams = new URLSearchParams(),
) {
  checkOwner(db, profileId);
  if (recordDurabilityStatus(db)) return indexedNoteHistory(db, profileId, id, params);
  const current = getNote(db, id) as NoteRecord,
    entries: JsonObject[] = [];
  const cursor = params.get('cursor');
  const limit = Math.max(1, Math.min(100, Math.floor(Number(params.get('limit'))) || 30));
  let cursorFound = !cursor,
    scanned = 0,
    nextCursor = null,
    complete = true,
    baseline = false;
  try {
    for (const generation of publishedPersonalLineage(
      root,
      profileId,
    ) as Iterable<PublishedGeneration>) {
      const generationId = generation.manifest.file.slice('snapshots/'.length);
      if (!cursorFound) {
        if (generationId === cursor) cursorFound = true;
        else continue;
      }
      if (scanned >= limit) {
        nextCursor = generationId;
        complete = false;
        break;
      }
      scanned++;
      baseline = !generation.value.history || !generation.value.history.previous;
      const old = fromSnapshot(generation.value, current.id);
      if (!old) continue;
      entries.push({
        generationId,
        savedAt: generation.value.createdAt,
        revision: generation.value.revision,
        noteVersion: old.version,
        status: old.status,
        publication: baseline ? 'baseline' : 'published',
        fields: fieldDiff(current, old),
        links: (generation.value.tables.note_links || []).filter(
          (link) => link.note_id === current.id,
        ).length,
        attachments: (generation.value.tables.attachments || []).filter(
          (link) =>
            (link.owner_type === 'note' && link.owner_id === current.id) ||
            (link.owner_type === 'person' && link.owner_id === current.personId),
        ).length,
      });
    }
    if (cursor && !cursorFound)
      throw new HttpError(
        404,
        'HISTORY_NOT_FOUND',
        'That history cursor is not in the published lineage',
      );
  } catch (error) {
    throw historyError(error);
  }
  return {
    noteId: current.id,
    currentVersion: current.version,
    finished: current.status === 'finished',
    entries,
    nextCursor,
    complete,
    baselineReached: baseline && complete,
    coverage:
      'Only the validated current snapshot and its published lineage are shown. Older unlinked files are not verified history.',
    durability: personalDurabilityStatus(db),
  };
}
function findGeneration(
  root: string,
  profileId: string,
  generationId: unknown,
): PublishedGeneration {
  if (typeof generationId !== 'string' || !/^\d{12}-[0-9a-f-]{36}\.json$/i.test(generationId))
    throw new HttpError(400, 'INVALID_GENERATION', 'Choose a generation from this entry’s history');
  try {
    for (const generation of publishedPersonalLineage(
      root,
      profileId,
    ) as Iterable<PublishedGeneration>)
      if (generation.manifest.file === 'snapshots/' + generationId) return generation;
  } catch (error) {
    throw historyError(error);
  }
  throw new HttpError(
    404,
    'HISTORY_NOT_FOUND',
    'This generation is not in the selected profile’s published history',
  );
}
function publicationFor(root: string, profileId: string, operation: RestoreOperation) {
  let match: string | null = null;
  try {
    for (const generation of publishedPersonalLineage(
      root,
      profileId,
    ) as Iterable<PublishedGeneration>) {
      if (
        (generation.value.restoreOperations || []).some(
          (row) => row.key === OP_PREFIX + operation.operationId,
        )
      )
        match = generation.manifest.file.slice('snapshots/'.length);
      else if (match) break;
    }
  } catch {
    return { generationId: match, published: Boolean(match), historyAvailable: false };
  }
  return { generationId: match, published: Boolean(match), historyAvailable: true };
}
export function restoreNoteFields(
  db: Database,
  root: string,
  profileId: string,
  id: string,
  input: RestoreInput,
) {
  checkOwner(db, profileId);
  if (recordDurabilityStatus(db)) return restoreIndexedNote(db, root, profileId, id, input);
  if (
    typeof input.operationId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      input.operationId,
    )
  )
    throw new HttpError(400, 'INVALID_OPERATION', 'A stable restoration operation ID is required');
  if (
    !Array.isArray(input.fields) ||
    !input.fields.length ||
    input.fields.length > 30 ||
    input.fields.some((field: unknown) => typeof field !== 'string')
  )
    throw new HttpError(400, 'INVALID_FIELDS', 'Select the fields to restore');
  if (input.request != null && (typeof input.request !== 'string' || input.request.length > 2000))
    throw new HttpError(
      400,
      'INVALID_INPUT',
      'Restoration request must be text within 2,000 characters',
    );
  const current = getNote(db, id) as NoteRecord;
  const fields = [...new Set(input.fields as string[])].sort();
  const request = {
    noteId: current.id,
    generationId: input.generationId,
    fields,
    version: input.version,
    request: input.request || 'Restore selected fields from saved history',
  };
  const fingerprint = createHash('sha256').update(JSON.stringify(request)).digest('hex');
  const stored = db
    .prepare('SELECT value FROM app_meta WHERE key=?')
    .get(OP_PREFIX + input.operationId);
  if (stored) {
    const operation = json(stored.value) as RestoreOperation;
    if (operation.fingerprint !== fingerprint)
      throw new HttpError(
        409,
        'OPERATION_CONFLICT',
        'This restoration ID was already used for a different request',
      );
    return {
      note: current,
      operation,
      replayed: true,
      recovery: publicationFor(root, profileId, operation),
      durability: personalDurabilityStatus(db),
    };
  }
  if (current.status === 'finished')
    throw new HttpError(
      409,
      'NOTE_FINISHED',
      'Finished history cannot be restored. Create a linked correction note.',
    );
  if (!Number.isInteger(input.version) || current.version !== input.version)
    throw new HttpError(
      409,
      'VERSION_CONFLICT',
      'This entry changed since history was opened. Refresh the comparison before restoring.',
    );
  const allowed = fieldsFor(current).filter((path) => !(current.isSelf && path === 'person.tags'));
  if (fields.some((field) => !allowed.includes(field)))
    throw new HttpError(
      400,
      'INVALID_FIELDS',
      'Only the listed editable fields can be restored; IDs, status, links and attachments stay unchanged',
    );
  const generation = findGeneration(root, profileId, input.generationId),
    old = fromSnapshot(generation.value, current.id);
  if (!old)
    throw new HttpError(
      404,
      'HISTORY_NOT_FOUND',
      'This entry did not exist in the selected generation',
    );
  // Do not resubmit associations, status, ownership or other unselected fields.
  // The ordinary save reads them inside its version-checked transaction.
  const payload: JsonObject & { person: JsonObject; textFormats: TextFormats; version: unknown } = {
    person: structuredClone(current.person),
    textFormats: { ...current.textFormats },
    version: input.version,
  };
  const changes: Array<{ path: string; before: HistoryCell; after: HistoryCell }> = [];
  for (const field of fields) {
    const previous = cell(old, field),
      present = cell(current, field);
    if (sameCell(previous, present)) continue;
    const key = field.replace(/^person\./, '');
    if (previous.format) payload.textFormats[key] = previous.format;
    const destination = field.startsWith('person.') ? payload.person : payload;
    if (!previous.present) {
      if (!field.startsWith('person.'))
        throw new HttpError(
          400,
          'INVALID_FIELDS',
          'A missing older storage field cannot be restored',
        );
      delete destination[key];
    } else destination[key] = structuredClone(previous.value);
    changes.push({ path: field, before: present, after: previous });
  }
  if (!changes.length)
    throw new HttpError(409, 'NO_CHANGES', 'The selected fields already match this saved state');
  if (current.kind === 'person' && fields.includes('person.name'))
    payload.title = payload.person.name;
  let operation: RestoreOperation | undefined;
  const note = (saveNote as unknown as SaveNoteForHistory)(db, current.id, payload, (saved) => {
    operation = {
      operationId: input.operationId as string,
      profileId,
      fingerprint,
      ...request,
      createdAt: now(),
      previousVersion: current.version,
      currentVersion: saved.version,
      revision: revision(db) + 1,
      changes: changes.map((change) => ({
        ...change,
        after: cell(saved as unknown as NoteRecord, change.path),
      })),
      status: 'saved',
    };
    db.prepare('INSERT INTO app_meta(key,value) VALUES(?,?)').run(
      OP_PREFIX + input.operationId,
      JSON.stringify(operation),
    );
  });
  return {
    note,
    operation,
    replayed: false,
    recovery: publicationFor(root, profileId, operation!),
    durability: personalDurabilityStatus(db),
  };
}

// Record-journal history reads only the unlocked profile's disposable indexes.
// Retained complete versions remain the source of every selected older value.
const uuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const hashValue = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
function indexedVersion(
  db: Database,
  profileId: string,
  entity: string,
  id: string,
  versionId: unknown,
): DurableRecordVersion {
  if (!uuid(versionId))
    throw new HttpError(
      400,
      'INVALID_GENERATION',
      'Choose a version from this entry’s saved history',
    );
  const row = readIndexedRecordVersion(db, profileId, entity, JSON.stringify([id]), versionId);
  if (!row)
    throw new HttpError(
      404,
      'HISTORY_NOT_FOUND',
      'This version is not in the selected entry’s history',
    );
  return row;
}
function rowAt(
  db: Database,
  profileId: string,
  entity: string,
  id: string,
  sequence: number,
): JsonObject | null {
  const row = db
    .prepare(
      'SELECT contents_json,deleted FROM __record_versions WHERE profile_id=? AND entity=? AND record_id=? AND sequence<=? ORDER BY sequence DESC LIMIT 1',
    )
    .get(profileId, entity, JSON.stringify([id]), sequence) as
    (SqliteRow & { contents_json: string; deleted: number }) | undefined;
  return row && !row.deleted ? (JSON.parse(row.contents_json) as JsonObject) : null;
}
function associationsAt(
  db: Database,
  profileId: string,
  current: NoteRecord,
  sequence: number,
  entity: string,
): AssociationRow[] {
  const condition =
    entity === 'note_links'
      ? "json_extract(v.contents_json,'$.note_id')=?"
      : "((json_extract(v.contents_json,'$.owner_type')='note' AND json_extract(v.contents_json,'$.owner_id')=?) OR (json_extract(v.contents_json,'$.owner_type')='person' AND json_extract(v.contents_json,'$.owner_id')=?))";
  const owners = entity === 'note_links' ? [current.id] : [current.id, current.personId || ''];
  return db
    .prepare(
      `SELECT v.contents_json FROM __record_versions v WHERE v.profile_id=? AND v.entity=? AND v.sequence<=? AND ${condition} AND v.deleted=0 AND NOT EXISTS(SELECT 1 FROM __record_versions newer WHERE newer.profile_id=v.profile_id AND newer.entity=v.entity AND newer.record_id=v.record_id AND newer.sequence>v.sequence AND newer.sequence<=?) ORDER BY v.record_id`,
    )
    .all(profileId, entity, sequence, ...owners, sequence)
    .map((row) => JSON.parse(row.contents_json as string) as AssociationRow);
}
function historicalNote(
  db: Database,
  profileId: string,
  current: NoteRecord,
  version: DurableRecordVersion,
): NoteRecord {
  const person = version.contents.person_id
    ? rowAt(db, profileId, 'people', version.contents.person_id as string, version.sequence)
    : null;
  return fromSnapshot(
    {
      tables: {
        notes: [version.contents as unknown as SnapshotNoteRow],
        people: person ? [person as SqliteRow & { id: string; display_name: string }] : [],
      },
    },
    current.id,
  )!;
}
function associationDiffs(
  db: Database,
  profileId: string,
  current: NoteRecord,
  sequence: number,
): Record<AssociationKind, AssociationDiff[]> {
  const links = associationsAt(db, profileId, current, sequence, 'note_links').map((row) => {
    const currentRow = db
      .prepare(
        'SELECT * FROM note_links WHERE id=? OR (note_id=? AND target_type=? AND target_id=? AND relation=?)',
      )
      .get(row.id, current.id, row.target_type, row.target_id, row.relation) as
      AssociationRow | undefined;
    const info = target(db, row.target_type, row.target_id),
      changed = !currentRow;
    return {
      id: row.id,
      kind: 'link',
      label: info.title,
      targetType: row.target_type,
      targetId: row.target_id,
      relation: row.relation,
      previous: {
        present: true,
        value: { targetType: row.target_type, targetId: row.target_id, relation: row.relation },
      },
      current: currentRow
        ? {
            present: true,
            value: {
              targetType: currentRow.target_type,
              targetId: currentRow.target_id,
              relation: currentRow.relation,
            },
          }
        : { present: false },
      changed,
      restorable: changed && !info.missing && !current.isSelf && current.status !== 'finished',
      reason: info.missing ? 'Linked target is unavailable' : null,
    };
  });
  const attachments = associationsAt(db, profileId, current, sequence, 'attachments').map((row) => {
    const currentRow = db
      .prepare(
        'SELECT * FROM attachments WHERE id=? OR (asset_id=? AND owner_type=? AND owner_id=? AND caption=? AND body_location IS ? AND event_date IS ? AND person_id IS ?)',
      )
      .get(
        row.id,
        row.asset_id,
        row.owner_type,
        row.owner_id,
        row.caption,
        row.body_location,
        row.event_date,
        row.person_id,
      ) as AssociationRow | undefined;
    const asset = db.prepare('SELECT * FROM assets WHERE id=?').get(row.asset_id) as
        (SqliteRow & { original_name: string }) | undefined,
      changed = !currentRow;
    const value = {
      assetId: row.asset_id,
      caption: row.caption,
      bodyLocation: row.body_location,
      eventDate: row.event_date,
      personId: row.person_id,
    };
    return {
      id: row.id,
      kind: 'attachment',
      label: asset?.original_name || 'Unavailable original',
      assetId: row.asset_id,
      previous: { present: true, value },
      current: currentRow
        ? {
            present: true,
            value: {
              assetId: currentRow.asset_id,
              caption: currentRow.caption,
              bodyLocation: currentRow.body_location,
              eventDate: currentRow.event_date,
              personId: currentRow.person_id,
            },
          }
        : { present: false },
      changed,
      restorable: changed && Boolean(asset) && current.status !== 'finished',
      reason: asset ? null : 'Retained original is unavailable',
    };
  });
  return { links, attachments };
}
function groupEntries(entries: IndexedHistoryEntry[]): Omit<HistoryGroup, 'key'>[] {
  const groups: HistoryGroup[] = [];
  for (const entry of entries) {
    const key = entry.sessionId || entry.operationId;
    let group = groups.at(-1);
    if (!group || group.key !== key) {
      group = {
        id: entry.generationId,
        key,
        sessionId: entry.sessionId,
        label: entry.sessionId ? 'Editing session' : 'Saved change',
        savedAt: entry.savedAt,
        entries: [],
      };
      groups.push(group);
    }
    group.entries.push(entry.generationId);
  }
  return groups.map(({ key, ...group }) => group);
}
function recordedChanges(
  version: DurableRecordVersion & { changes: RecordFieldChange[] },
  current: NoteRecord,
) {
  const names = { note_type: 'typeLabel', event_date: 'eventDate', raw_thoughts: 'rawThoughts' };
  const allowed = fieldsFor(current);
  return version.changes.flatMap((change) => {
    const path = change.field.startsWith('profile_json.')
      ? 'person.' + change.field.slice(13)
      : names[change.field as keyof typeof names] || change.field;
    if (!allowed.includes(path)) return [];
    const value = (cell: HistoryCell): HistoryCell =>
      path === 'pinned' && cell.present ? { ...cell, value: Boolean(cell.value) } : cell;
    return [
      {
        path,
        label: LABELS[path.replace(/^person\./, '') as keyof typeof LABELS],
        before: value(change.before),
        after: value(change.after),
      },
    ];
  });
}
function indexedNoteHistory(db: Database, profileId: string, id: string, params: URLSearchParams) {
  const current = getNote(db, id) as NoteRecord,
    limit = Math.max(1, Math.min(100, Math.floor(Number(params.get('limit'))) || 30)),
    cursor = params.get('cursor');
  const before = cursor
    ? indexedVersion(db, profileId, 'notes', current.id, cursor).sequence + 1
    : Number.MAX_SAFE_INTEGER;
  const result = queryRecordHistory(db, {
    profileId,
    entity: 'notes',
    recordId: current.id,
    beforeSequence: before,
    limit,
  });
  const entries = result.entries.map((version) => {
    const old = historicalNote(db, profileId, current, version),
      associations = associationDiffs(db, profileId, current, version.sequence);
    const commit = JSON.parse(
      db
        .prepare('SELECT commit_json FROM __record_transactions WHERE sequence=?')
        .get(version.sequence)!.commit_json as string,
    ) as { revision: number };
    return {
      generationId: version.versionId,
      savedAt: version.recordedAt,
      revision: commit.revision,
      sequence: version.sequence,
      noteVersion: old.version,
      status: old.status,
      publication: version.previousVersion ? 'published' : 'baseline',
      fields: fieldDiff(current, old),
      recordedChanges: recordedChanges(version, current),
      links: associations.links.length,
      attachments: associations.attachments.length,
      associations,
      operationId: version.operationId,
      sessionId:
        (version.origin as JsonObject | null)?.kind === 'note-editor' &&
        uuid((version.origin as JsonObject).sessionId)
          ? (version.origin as JsonObject).sessionId
          : null,
      actor: version.actor,
      origin: version.origin,
      references: version.references,
    };
  });
  const next = result.nextSequence
    ? db
        .prepare(
          "SELECT version_id FROM __record_versions WHERE profile_id=? AND entity='notes' AND record_id=? AND sequence<? ORDER BY sequence DESC LIMIT 1",
        )
        .get(profileId, JSON.stringify([current.id]), result.nextSequence)?.version_id
    : null;
  return {
    noteId: current.id,
    currentVersion: current.version,
    currentRevision: revision(db),
    finished: current.status === 'finished',
    entries,
    groups: groupEntries(entries as IndexedHistoryEntry[]),
    nextCursor: next || null,
    complete: !next,
    baselineReached: !next,
    coverage:
      'Every accepted version remains available. Editing sessions group related saves; expand a session to inspect each change.',
    format: 'record-versions',
    durability: personalDurabilityStatus(db),
  };
}
function normalizedSelection(input: RestoreInput): NormalizedSelection {
  if (
    !input ||
    !Array.isArray(input.fields) ||
    input.fields.length > 30 ||
    input.fields.some((field: unknown) => typeof field !== 'string')
  )
    throw new HttpError(400, 'INVALID_FIELDS', 'Select fields or removed associations to restore');
  const associations = (input.associations || {}) as Record<string, unknown>;
  if (
    !associations ||
    typeof associations !== 'object' ||
    Array.isArray(associations) ||
    Object.keys(associations).some((key) => !['links', 'attachments'].includes(key))
  )
    throw new HttpError(
      400,
      'INVALID_ASSOCIATIONS',
      'Select saved link or attachment association IDs',
    );
  const selection: NormalizedSelection = {
    fields: [...new Set(input.fields as string[])].sort(),
    associations: { links: [], attachments: [] },
  };
  for (const kind of ['links', 'attachments'] as const) {
    const ids = associations[kind] || [];
    if (
      !Array.isArray(ids) ||
      ids.length > 100 ||
      ids.some((id: unknown) => typeof id !== 'string' || id.length > 200)
    )
      throw new HttpError(400, 'INVALID_ASSOCIATIONS', 'Select saved association IDs');
    selection.associations[kind] = [...new Set(ids as string[])].sort();
  }
  if (
    !selection.fields.length &&
    !selection.associations.links.length &&
    !selection.associations.attachments.length
  )
    throw new HttpError(400, 'INVALID_FIELDS', 'Select fields or removed associations to restore');
  if (input.request != null && (typeof input.request !== 'string' || input.request.length > 2000))
    throw new HttpError(
      400,
      'INVALID_INPUT',
      'Restoration request must be within 2,000 characters',
    );
  return selection;
}
function planRestoration(
  db: Database,
  root: string,
  profileId: string,
  id: string,
  input: RestoreInput,
): RestorationPlan {
  checkOwner(db, profileId);
  if (!recordDurabilityStatus(db))
    throw new HttpError(
      400,
      'HISTORY_FORMAT',
      'Restoration preview requires indexed record history',
    );
  const current = getNote(db, id) as NoteRecord,
    selection = normalizedSelection(input);
  if (current.status === 'finished')
    throw new HttpError(
      409,
      'NOTE_FINISHED',
      'Finished history cannot be restored. Create a linked correction note.',
    );
  if (
    !Number.isSafeInteger(input.version) ||
    input.version !== current.version ||
    (input.expectedRevision !== undefined && input.expectedRevision !== revision(db))
  )
    throw new HttpError(
      409,
      'VERSION_CONFLICT',
      'This profile changed. Refresh the comparison before restoring.',
    );
  const allowed = fieldsFor(current).filter((path) => !(current.isSelf && path === 'person.tags'));
  if (selection.fields.some((field) => !allowed.includes(field)))
    throw new HttpError(400, 'INVALID_FIELDS', 'Only listed editable fields can be restored');
  const version = indexedVersion(db, profileId, 'notes', current.id, input.generationId),
    old = historicalNote(db, profileId, current, version);
  if (old.kind !== current.kind)
    throw new HttpError(
      409,
      'ENTRY_KIND_CHANGED',
      'This entry changed kind. Choose a saved version of its current kind.',
    );
  const changes = fieldDiff(current, old).filter(
    (field) => selection.fields.includes(field.path) && field.changed,
  );
  const diffs = associationDiffs(db, profileId, current, version.sequence),
    rows: Record<AssociationKind, AssociationRow[]> = { links: [], attachments: [] };
  const associationChanges: AssociationDiff[] = [],
    restoredFrom = [version.versionId];
  for (const [kind, entity] of [
    ['links', 'note_links'],
    ['attachments', 'attachments'],
  ] as const) {
    const available = associationsAt(db, profileId, current, version.sequence, entity);
    for (const id of selection.associations[kind]) {
      const diff = diffs[kind].find((row) => row.id === id),
        row = available.find((row) => row.id === id);
      if (!diff || !row)
        throw new HttpError(
          404,
          'HISTORY_NOT_FOUND',
          'The selected association does not belong to this saved entry',
        );
      if (!diff.restorable)
        throw new HttpError(
          409,
          'ASSOCIATION_CONFLICT',
          diff.reason || 'This association is already present or cannot be restored',
        );
      if (kind === 'attachments') {
        const asset = db
          .prepare('SELECT * FROM assets WHERE id=?')
          .get(row.asset_id) as SqliteRow & {
          stored_path: string;
          bytes: number;
          sha256: string;
        };
        let bytes;
        try {
          bytes = readFileSync(profileFile(root, asset.stored_path, profileId));
        } catch {
          throw new HttpError(
            409,
            'ASSET_INTEGRITY',
            'The retained attachment original is missing or changed',
          );
        }
        if (
          bytes.length !== asset.bytes ||
          createHash('sha256').update(bytes).digest('hex') !== asset.sha256
        )
          throw new HttpError(
            409,
            'ASSET_INTEGRITY',
            'The retained attachment original is missing or changed',
          );
        if (row.person_id && !db.prepare('SELECT 1 FROM people WHERE id=?').get(row.person_id))
          throw new HttpError(
            409,
            'ASSOCIATION_CONFLICT',
            'The attachment’s linked person is unavailable',
          );
      }
      rows[kind].push(row);
      associationChanges.push(diff);
      restoredFrom.push(
        db
          .prepare(
            'SELECT version_id FROM __record_versions WHERE profile_id=? AND entity=? AND record_id=? AND sequence<=? ORDER BY sequence DESC LIMIT 1',
          )
          .get(profileId, entity, JSON.stringify([id]), version.sequence)!.version_id as string,
      );
    }
  }
  if (!changes.length && !associationChanges.length)
    throw new HttpError(409, 'NO_CHANGES', 'The selected values already match this saved state');
  const preview = {
    noteId: current.id,
    generationId: version.versionId,
    version: current.version,
    expectedRevision: revision(db),
    ...selection,
    changes: changes.map((field) => ({
      path: field.path,
      label: field.label,
      before: field.current,
      after: field.previous,
    })),
    associationChanges,
    restoredFrom,
  };
  return {
    current,
    old,
    rows,
    preview: { ...preview, previewToken: hashValue(preview) },
  };
}
export function previewNoteRestoration(
  db: Database,
  root: string,
  profileId: string,
  id: string,
  input: RestoreInput,
) {
  return planRestoration(db, root, profileId, id, input).preview;
}
function indexedPublication(db: Database, operation: RestoreOperation) {
  const row = db
    .prepare(
      "SELECT version_id FROM __record_versions WHERE entity='notes' AND record_id=? AND operation_id=? ORDER BY sequence DESC LIMIT 1",
    )
    .get(JSON.stringify([operation.noteId]), operation.operationId);
  return { generationId: row?.version_id || null, published: Boolean(row), historyAvailable: true };
}
function restoreIndexedNote(
  db: Database,
  root: string,
  profileId: string,
  id: string,
  input: RestoreInput,
) {
  if (!uuid(input?.operationId))
    throw new HttpError(400, 'INVALID_OPERATION', 'A stable restoration operation ID is required');
  const current = getNote(db, id) as NoteRecord,
    selection = normalizedSelection(input);
  const request = {
    noteId: current.id,
    generationId: input.generationId,
    ...selection,
    version: input.version,
    expectedRevision: input.expectedRevision,
    previewToken: input.previewToken,
    request: input.request || 'Restore selected saved values',
  };
  const fingerprint = hashValue(request),
    stored = db
      .prepare('SELECT value FROM app_meta WHERE key=?')
      .get(OP_PREFIX + input.operationId);
  if (stored) {
    const operation = JSON.parse(stored.value as string) as RestoreOperation;
    if (operation.fingerprint !== fingerprint)
      throw new HttpError(
        409,
        'OPERATION_CONFLICT',
        'This restoration ID was used for a different request',
      );
    return {
      note: current,
      operation,
      replayed: true,
      recovery: indexedPublication(db, operation),
      durability: personalDurabilityStatus(db),
    };
  }
  if (typeof input.previewToken !== 'string' || !Number.isSafeInteger(input.expectedRevision))
    throw new HttpError(400, 'PREVIEW_REQUIRED', 'Preview the selected changes before restoring');
  const { old, rows, preview } = planRestoration(db, root, profileId, current.id, input);
  if (input.previewToken !== preview.previewToken)
    throw new HttpError(
      409,
      'VERSION_CONFLICT',
      'The restoration preview changed. Refresh it before applying.',
    );
  const payload: JsonObject & { person: JsonObject; textFormats: TextFormats; version: number } = {
    person: structuredClone(current.person),
    textFormats: { ...current.textFormats },
    version: current.version,
  };
  for (const change of preview.changes) {
    const value = cell(old, change.path),
      key = change.path.replace(/^person\./, ''),
      destination = change.path.startsWith('person.') ? payload.person : payload;
    if (value.format) payload.textFormats[key] = value.format;
    if (value.present) destination[key] = structuredClone(value.value);
    else if (change.path.startsWith('person.')) delete destination[key];
    else
      throw new HttpError(
        400,
        'INVALID_FIELDS',
        'An absent older storage field cannot be restored',
      );
  }
  if (current.kind === 'person' && selection.fields.includes('person.name'))
    payload.title = payload.person.name;
  let operation: RestoreOperation | undefined;
  const note = saveNote(
    db,
    current.id,
    payload,
    (saved) => {
      for (const [kind, table] of [
        ['links', 'note_links'],
        ['attachments', 'attachments'],
      ] as const)
        for (const row of rows[kind]) {
          const keys = Object.keys(row);
          db.prepare(
            `INSERT INTO ${table} (${keys.map((key) => '"' + key + '"').join(',')}) VALUES(${keys.map(() => '?').join(',')})`,
          ).run(...keys.map((key) => row[key] as SQLInputValue));
        }
      operation = {
        operationId: input.operationId as string,
        profileId,
        fingerprint,
        ...request,
        createdAt: now(),
        previousVersion: current.version,
        currentVersion: saved.version,
        revision: revision(db) + 1,
        changes: preview.changes.map((change) => ({
          ...change,
          after: cell(saved as unknown as NoteRecord, change.path),
        })),
        associationChanges: preview.associationChanges,
        restoredFrom: preview.restoredFrom,
        status: 'saved',
      };
      db.prepare('INSERT INTO app_meta(key,value) VALUES(?,?)').run(
        OP_PREFIX + input.operationId,
        JSON.stringify(operation),
      );
    },
    {
      operationId: input.operationId,
      fingerprint,
      expectedRevision: input.expectedRevision,
      origin: 'history-restoration',
      references: {
        restoredFrom: preview.restoredFrom,
        selection: { fields: selection.fields, associations: selection.associations },
      },
    },
  );
  return {
    note,
    operation,
    replayed: false,
    recovery: indexedPublication(db, operation!),
    durability: personalDurabilityStatus(db),
  };
}
