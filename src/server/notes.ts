import {
  rememberNameSupport,
  rememberManualNameChanges,
  nameAuthorities,
  sourceNameConfirmationDate,
} from './name-associations.ts';
import {
  canonicalIdentityName,
  savedKnownNames,
  knownNamesError,
} from '../shared/self-identity.ts';
import {
  resolveClinicalReference,
  clinicalReferenceKinds,
  clinicalReferenceAliases,
  clinicalNavigation,
} from './clinical-references.ts';
import { requireMedicationSetupReview } from './medication-preferences.ts';
import { validPersonIcon } from '../shared/person-icon.ts';
import { personDisplayKey } from '../shared/person-display.ts';
import personIconCatalog from '../shared/person-icon-catalog.json' with { type: 'json' };
import { visibilityState, noteVisibilitySQL, visibilityCondition } from './visibility.ts';
import { collectionPredicates } from './collection-filters.ts';
import { randomUUID, randomInt } from 'node:crypto';
import {
  canonicalPersonTag,
  selfTagError,
  withoutPersonTags,
  normalizePersonTags,
  normalizedPersonCare,
  personContactError,
  PERSON_TAG_SUGGESTIONS,
} from '../shared/person-care.ts';
import {
  HttpError,
  json,
  managedTimestamp,
  now,
  required,
  safeText,
  optionalText,
  transaction,
} from './database.ts';
import type { Database, SqliteRow, TransactionOperation } from './database.ts';
import type {
  Asset,
  Attachment,
  LinkTarget,
  LinkTargetType,
  Note,
  NoteKind,
  NoteLink,
  NoteLinkInput,
  NoteStatus,
  NoteTextFormat,
  NoteTextFormats,
  PersonProfile,
} from '../shared/api.ts';
import type { IntakeEvidencedIdentity } from '../shared/intake-identity.ts';
import { pagination } from './queries.ts';

interface NoteRow extends SqliteRow {
  id: string;
  kind: NoteKind;
  status: NoteStatus;
  title: string;
  content: string;
  text_formats_json: string | null;
  note_type: string | null;
  event_date: string | null;
  topics: string;
  raw_thoughts: string;
  person_id: string | null;
  profile_json: string | null;
  pinned: number;
  archived: number;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
  version: number;
  source_record_id: string | null;
}
interface PersonIdentityRow extends SqliteRow {
  display_name: string;
  version: number;
  profile_json: string | null;
}
interface TargetRow {
  title: string;
  archived: number;
  kind?: NoteKind;
  person_id?: string | null;
  source_record_id?: string;
}
interface AssetRow extends SqliteRow {
  id: string;
  original_name: string;
  mime_type: string;
  bytes: number;
  sha256: string;
  created_at: string;
  attribution: string;
}
interface AttachmentRow extends SqliteRow {
  id: string;
  asset_id: string;
  owner_type: Attachment['ownerType'];
  owner_id: string;
  caption: string;
  body_location: string | null;
  event_date: string | null;
  person_id: string | null;
  created_at: string;
}
interface NoteLinkRow {
  id: string;
  note_id: string;
  target_type: LinkTargetType;
  target_id: string;
  relation: string;
  title: string;
}
interface RelatedNoteRow extends NoteRow {
  ownership_redirect: number;
  relations: string;
}
interface LinkSearchRow {
  id: string;
  title: string;
  subtitle: string | null;
  kind?: NoteKind;
  person_id?: string | null;
  note_type?: string | null;
  status?: NoteStatus;
  archived?: number;
}
type NoteValues = Record<string, unknown>;
interface ValidatedNoteValues {
  title: string;
  content: string;
  textFormats: NoteTextFormats;
  typeLabel: string | null;
  eventDate: string | null;
  topics: string;
  rawThoughts: string;
  person: PersonProfile;
  pinned: number;
  archived: number;
}
interface ResolvedLinkTarget {
  ownershipRedirect?: boolean;
  targetType: LinkTargetType;
  targetId: string;
  title: string;
  archived: boolean;
  missing: boolean;
  current: true;
  resolvedTargetType?: LinkTargetType;
  appUrl?: string;
  apiUrl?: string;
  sourceRecordId?: string;
}
export type NoteDTO = Note & Record<string, unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const objectInput = (value: unknown): NoteValues => {
  if (!isRecord(value)) throw new HttpError(400, 'INVALID_INPUT', 'Request body must be an object');
  return value;
};
const storedPerson = (source: unknown): PersonProfile => {
  const value = json(source, {});
  return isRecord(value) ? value : {};
};
const TEXT_FIELDS = ['content', 'topics', 'rawThoughts', 'medicalHistory'] as const;
const TEXT_FORMATS = ['plain-v1', 'markdown-v1'] as const;
export const LINK_TYPES = [
  'note',
  'person',
  'observation',
  'test_type',
  'medication',
  'procedure',
  'source',
  'document',
] as const satisfies readonly LinkTargetType[];
const isLinkTargetType = (value: unknown): value is LinkTargetType =>
  typeof value === 'string' && LINK_TYPES.includes(value as LinkTargetType);
const isTextFormat = (value: unknown): value is NoteTextFormat =>
  typeof value === 'string' && TEXT_FORMATS.includes(value as NoteTextFormat);
const storedTextFormats = (source: unknown): NoteTextFormats => {
  const value = json(source, {});
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      ([key, format]) =>
        TEXT_FIELDS.includes(key as (typeof TEXT_FIELDS)[number]) && isTextFormat(format),
    ),
  );
};

const newId = (prefix: string): string => `${prefix}:${randomUUID()}`;
export function noteRow(db: Database, id: string): NoteRow {
  return required(
    db.prepare('SELECT * FROM notes WHERE id=? OR person_id=?').get(id, id) as NoteRow | undefined,
    'Note not found',
  );
}
// The patient row owns the editable display name. Legacy note titles may still
// say "Self"; identity is always the stable person ID, never a display label.
export function selfIdentity(db: Database): { name: string; nameVersion: number; icon?: string } {
  const row = required(
    db
      .prepare(
        "SELECT p.display_name,n.version,n.profile_json FROM people p JOIN notes n ON n.person_id=p.id WHERE p.id='patient' AND n.kind='person'",
      )
      .get() as PersonIdentityRow | undefined,
    'Self profile not found',
  );
  const icon = storedPerson(row.profile_json).icon;
  return {
    name: row.display_name,
    nameVersion: row.version,
    ...(icon && validPersonIcon(icon) ? { icon } : {}),
  };
}
function displayTitle(
  db: Database,
  row: { kind?: NoteKind; person_id?: string | null; title: string },
): string {
  return row.kind === 'person' && row.person_id === 'patient' ? selfIdentity(db).name : row.title;
}
export function target(
  db: Database,
  type: LinkTargetType,
  id: string,
): Omit<NoteLink, 'id' | 'targetType' | 'targetId' | 'relation'> {
  const originalId = id;
  const resolved = resolveClinicalReference(db, type, id);
  if (resolved) {
    type = resolved.kind;
    id = resolved.recordId;
  }
  const navigation = resolved ? clinicalNavigation(type, id) : null;
  let r: TargetRow | undefined;
  if (type === 'note')
    r = db
      .prepare('SELECT n.title,n.archived,n.kind,n.person_id FROM notes n WHERE n.id=?')
      .get(id) as TargetRow | undefined;
  else if (type === 'person')
    r =
      (db
        .prepare('SELECT n.title,n.archived,n.kind,n.person_id FROM notes n WHERE n.person_id=?')
        .get(id) as TargetRow | undefined) ||
      (db.prepare('SELECT display_name AS title,0 AS archived FROM people WHERE id=?').get(id) as
        TargetRow | undefined);
  else if (['observation', 'test_type', 'medication', 'procedure'].includes(type)) {
    const table: Record<string, string> = {
      observation: 'observations',
      test_type: 'test_types',
      medication: 'medications',
      procedure: 'procedures',
    };
    r = db.prepare(`SELECT label AS title,0 AS archived FROM ${table[type]} WHERE id=?`).get(id) as
      TargetRow | undefined;
  } else if (type === 'source')
    r =
      (db
        .prepare(
          'SELECT COALESCE(r.label,r.source_key,f.path,r.id) AS title,0 AS archived,r.id AS source_record_id FROM source_records r JOIN source_files f ON f.id=r.source_file_id WHERE r.id=?',
        )
        .get(id) as TargetRow | undefined) ||
      (db.prepare('SELECT path AS title,0 AS archived FROM source_files WHERE id=?').get(id) as
        TargetRow | undefined);
  else if (type === 'document')
    r = db.prepare('SELECT title,0 AS archived FROM documents WHERE id=?').get(id) as
      TargetRow | undefined;
  return {
    title: r ? displayTitle(db, r) : 'Unavailable linked record',
    archived: r
      ? visibilityState(db, type === 'source' && !r.source_record_id ? 'source_file' : type, id)
          .archived
      : false,
    missing: !r,
    current: true,
    ...(resolved && resolved.recordId !== originalId ? { ownershipRedirect: true } : {}),
    ...(navigation
      ? { resolvedTargetType: type, appUrl: navigation.appUrl, apiUrl: navigation.apiUrl }
      : {}),
    ...(r?.source_record_id ? { sourceRecordId: r.source_record_id } : {}),
  };
}
export function assetDTO(value: SqliteRow): Asset & Record<string, unknown> {
  const r = value as AssetRow;
  return {
    id: r.id,
    originalName: r.original_name,
    mimeType: r.mime_type,
    bytes: r.bytes,
    sha256: r.sha256,
    createdAt: managedTimestamp(r.created_at),
    attribution: r.attribution,
    contentUrl: '/api/assets/' + encodeURIComponent(r.id) + '/content',
  };
}
export function attachmentDTO(db: Database, value: SqliteRow): Attachment {
  const r = value as AttachmentRow;
  return {
    id: r.id,
    assetId: r.asset_id,
    ownerType: r.owner_type,
    ownerId: r.owner_id,
    caption: r.caption,
    bodyLocation: r.body_location,
    eventDate: r.event_date,
    personId: r.person_id,
    createdAt: managedTimestamp(r.created_at),
    asset: assetDTO(
      required(
        db.prepare('SELECT * FROM assets WHERE id=?').get(r.asset_id) as AssetRow | undefined,
        'Attachment original missing',
      ),
    ),
  };
}
export function attachments(db: Database, type: string, id: string): Attachment[] {
  const resolved = resolveClinicalReference(db, type, id);
  if (resolved) {
    type = resolved.kind;
    id = resolved.recordId;
  }
  return db
    .prepare(
      'SELECT * FROM attachments WHERE owner_type=? AND owner_id=? ORDER BY event_date,created_at',
    )
    .all(type, id)
    .map((r) => attachmentDTO(db, r));
}
export function getNote(db: Database, id: string): NoteDTO {
  const r = noteRow(db, id);
  const storedProfile = storedPerson(r.profile_json);
  const displayProfile =
    r.kind === 'person'
      ? {
          ...storedProfile,
          sourceKnownNames: storedProfile.sourceKnownNames?.map((source) => ({
            ...source,
            confirmedAt: sourceNameConfirmationDate(db, r.id, source.operationId, source.name),
          })),
        }
      : storedProfile;
  const links = db
    .prepare('SELECT * FROM note_links WHERE note_id=? ORDER BY id')
    .all(r.id)
    .map((l): NoteLink => {
      const link = l as unknown as NoteLinkRow;
      return {
        id: link.id,
        targetType: link.target_type,
        targetId: link.target_id,
        relation: link.relation,
        ...target(db, link.target_type, link.target_id),
      };
    });
  const backlinks = db
    .prepare(
      "SELECT l.*,n.title,n.archived FROM note_links l JOIN notes n ON n.id=l.note_id WHERE (l.target_type='note' AND l.target_id=?) OR (l.target_type='person' AND l.target_id=?) ORDER BY n.updated_at DESC",
    )
    .all(r.id, r.person_id || '')
    .map((l): NoteLink => {
      const link = l as unknown as NoteLinkRow;
      return {
        id: link.id,
        targetType: 'note',
        targetId: link.note_id,
        relation: link.relation,
        title: link.title ?? '',
        archived: visibilityState(db, 'note', link.note_id).archived,
        missing: false,
        current: true,
      };
    });
  return {
    id: r.id,
    kind: r.kind,
    isSelf: r.kind === 'person' && r.person_id === 'patient',
    status: r.status,
    title: displayTitle(db, r),
    content: r.content,
    textFormats: storedTextFormats(r.text_formats_json),
    typeLabel: r.note_type,
    eventDate: r.event_date,
    topics: r.topics,
    rawThoughts: r.raw_thoughts,
    personId: r.person_id,
    ownerPersonId:
      r.kind === 'person'
        ? r.person_id || 'patient'
        : String(storedPerson(r.profile_json).recordOwnerPersonId || 'patient'),
    person:
      r.kind === 'person' && r.person_id === 'patient'
        ? {
            ...withoutPersonTags(displayProfile),
            name: selfIdentity(db).name,
            nameAssociations: nameAuthorities(db, r.id),
          }
        : {
            ...displayProfile,
            ...(r.kind === 'person' ? { nameAssociations: nameAuthorities(db, r.id) } : {}),
          },
    pinned: Boolean(r.pinned),
    archived: visibilityState(db, 'note', r.id).archived,
    createdAt: managedTimestamp(r.created_at),
    updatedAt: managedTimestamp(r.updated_at),
    finishedAt: managedTimestamp(r.finished_at),
    version: r.version,
    sourceRecordId: r.source_record_id,
    links,
    backlinks,
    attachments: [
      ...attachments(db, 'note', r.id),
      ...(r.person_id ? attachments(db, 'person', r.person_id) : []),
    ],
  };
}
export function listNotes(db: Database, params: URLSearchParams) {
  const pg = pagination(params),
    w = [visibilityCondition(params, noteVisibilitySQL())],
    args: string[] = [];
  for (const [key, col] of [
    ['kind', 'kind'],
    ['status', 'status'],
    ['typeLabel', 'note_type'],
  ]) {
    const value = params.get(key);
    if (!value) continue;
    w.push(col + '=? COLLATE NOCASE');
    args.push(value);
  }
  if (params.get('kind') !== 'person') {
    w.push(
      "kind<>'person' AND COALESCE(json_extract(profile_json,'$.recordOwnerPersonId'),'patient')=?",
    );
    args.push(params.get('personId') || 'patient');
  }
  if (params.get('kind') === 'person' && params.get('excludeSelf') === '1')
    w.push("COALESCE(person_id,'') <> 'patient'");
  if (params.get('pinned') === '1') w.push('pinned=1');
  if (params.get('tag')) {
    const tag = canonicalPersonTag(safeText(params.get('tag'), 'tag', 80));
    if (tag) {
      w.push(
        "kind='person' AND person_id <> 'patient' AND EXISTS(SELECT 1 FROM json_each(CASE WHEN json_type(profile_json,'$.tags')='array' THEN json_extract(profile_json,'$.tags') ELSE '[]' END) WHERE type='text' AND value=? COLLATE NOCASE)",
      );
      args.push(tag);
    }
  }
  if (params.has('filters')) {
    if (params.get('kind') !== 'person')
      throw new HttpError(
        400,
        'INVALID_FILTER',
        'Builder filters apply to People or Historical Notes.',
      );
    const filters = collectionPredicates(params, 'person');
    w.push(...filters.conditions);
    args.push(...filters.args);
  }
  if (params.get('q')) {
    w.push(
      "(title LIKE ? OR content LIKE ? OR profile_json LIKE ? OR note_type LIKE ? OR (kind='person' AND person_id='patient' AND EXISTS(SELECT 1 FROM people WHERE id='patient' AND display_name LIKE ?)))",
    );
    args.push(...Array(5).fill('%' + params.get('q') + '%'));
  }
  const where = ' WHERE ' + w.join(' AND '),
    total = Number(
      (
        db.prepare('SELECT COUNT(*) AS n FROM notes' + where).get(...args) as
          { n: number } | undefined
      )?.n ?? 0,
    );
  const data = db
    .prepare(
      'SELECT id FROM notes' + where + ' ORDER BY pinned DESC,updated_at DESC,id LIMIT ? OFFSET ?',
    )
    .all(...args, pg.limit, pg.offset)
    .map((r) => getNote(db, String(r.id)));
  return {
    data,
    total,
    ...pg,
    complete: pg.offset === 0 && data.length === total,
  };
}
export function checkEditable(row: Pick<NoteRow, 'status' | 'version'>, version: unknown): void {
  if (row.status === 'finished')
    throw new HttpError(
      409,
      'NOTE_FINISHED',
      'This note is finished. Create a new linked note to make a correction.',
    );
  if (!Number.isInteger(version) || version !== row.version)
    throw new HttpError(
      409,
      'VERSION_CONFLICT',
      'This note changed since you opened it. Reload before saving.',
    );
}
function normalizeType(db: Database, value: unknown): string | null {
  const t = optionalText(value, 'typeLabel', 100)?.trim() || null;
  if (!t) return null;
  const existing = db
    .prepare('SELECT note_type FROM notes WHERE note_type=? COLLATE NOCASE LIMIT 1')
    .get(t) as { note_type: string } | undefined;
  const builtIn = ['Therapy', 'Primary care', 'Specialist'].find(
    (x) => x.toLowerCase() === t.toLowerCase(),
  );
  return existing?.note_type || builtIn || t;
}
function validateTextFormats(value: unknown): NoteTextFormats {
  if (
    !value ||
    !isRecord(value) ||
    Object.keys(value).some(
      (key) =>
        !TEXT_FIELDS.includes(key as (typeof TEXT_FIELDS)[number]) || !isTextFormat(value[key]),
    )
  )
    throw new HttpError(
      400,
      'INVALID_INPUT',
      'Text formats must map supported note fields to plain-v1 or markdown-v1',
    );
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}
function validateInput(
  db: Database,
  input: NoteValues,
  current: Partial<NoteRow> = {},
): ValidatedNoteValues {
  const title = safeText(input.title ?? current.title ?? '', 'title', 500).trim();
  if (!title) throw new HttpError(400, 'INVALID_INPUT', 'A title is required');
  let person: Record<string, unknown> =
    input.person === undefined
      ? storedPerson(current.profile_json)
      : isRecord(input.person)
        ? input.person
        : {};
  if (
    (input.person !== undefined && !isRecord(input.person)) ||
    JSON.stringify(person).length > 1000000
  )
    throw new HttpError(400, 'INVALID_INPUT', 'Person profile must be an object');
  const retainedNames = storedPerson(current.profile_json).sourceKnownNames || [];
  // Evidence names are server-owned. Ordinary edits and historical field
  // restoration may edit manual names, but cannot remove or forge evidence.
  person = { ...person };
  delete person.sourceKnownNames;
  delete person.nameAssociations;
  if (retainedNames.length) {
    person.sourceKnownNames = retainedNames;
    const submitted = person.knownNames === undefined ? [] : person.knownNames;
    if (!Array.isArray(submitted))
      throw new HttpError(400, 'INVALID_INPUT', 'Known names must be a list');
    const names = [...submitted] as unknown[];
    for (const entry of retainedNames)
      if (
        !names.some(
          (name) =>
            typeof name === 'string' &&
            canonicalIdentityName(name) === canonicalIdentityName(entry.name),
        )
      )
        names.push(entry.name);
    person.knownNames = names;
  }
  const selfError = selfTagError(
    isRecord(input.person) ? input.person : undefined,
    current.person_id === 'patient',
  );
  if (selfError) throw new HttpError(400, 'SELF_PROFILE', selfError);
  if (current.person_id === 'patient') person = withoutPersonTags(person);
  for (const key of [
    'name',
    'fullName',
    'pronouns',
    'birthDate',
    'deathDate',
    'relationship',
    'medicalHistory',
    'bloodType',
    'bloodTypeSource',
    'bloodTypeUncertainty',
  ])
    if (person[key] != null) safeText(person[key], key);
  validatePerson(person, storedPerson(current.profile_json));
  const contactError = personContactError(person);
  if (contactError) throw new HttpError(400, 'INVALID_INPUT', contactError);
  try {
    person = normalizedPersonCare(person);
  } catch (error) {
    throw new HttpError(
      400,
      'INVALID_INPUT',
      error instanceof Error ? error.message : String(error),
    );
  }
  for (const key of ['pinned', 'archived'])
    if (input[key] != null && typeof input[key] !== 'boolean')
      throw new HttpError(400, 'INVALID_INPUT', key + ' must be boolean');
  // The metadata key is server-owned. Absence in legacy versions retains Self.
  const noteKind = current.kind || input.kind || 'note';
  const storedOwner = storedPerson(current.profile_json).recordOwnerPersonId;
  if (noteKind !== 'person') {
    if (current.id) {
      if (input.ownerPersonId !== undefined && input.ownerPersonId !== (storedOwner || 'patient'))
        throw new HttpError(
          400,
          'NOTE_OWNER_IMMUTABLE',
          'Changing the view cannot reassign an existing note.',
        );
      delete person.recordOwnerPersonId;
      if (storedOwner) person.recordOwnerPersonId = storedOwner;
    } else {
      person.recordOwnerPersonId = validatedNoteOwner(db, input.ownerPersonId);
    }
  } else {
    delete person.recordOwnerPersonId;
  }
  const validatedPerson = person as PersonProfile;
  return {
    title,
    content: safeText(input.content ?? current.content ?? '', 'content'),
    textFormats: validateTextFormats(
      input.textFormats === undefined
        ? storedTextFormats(current.text_formats_json)
        : input.textFormats,
    ),
    typeLabel: normalizeType(
      db,
      input.typeLabel === undefined ? current.note_type : input.typeLabel,
    ),
    eventDate: optionalText(
      input.eventDate === undefined ? current.event_date : input.eventDate,
      'eventDate',
      100,
    ),
    topics: safeText(input.topics ?? current.topics ?? '', 'topics'),
    rawThoughts: safeText(input.rawThoughts ?? current.raw_thoughts ?? '', 'rawThoughts'),
    person: validatedPerson,
    pinned: input.pinned === undefined ? current.pinned || 0 : Number(input.pinned),
    archived: input.archived === undefined ? current.archived || 0 : Number(input.archived),
  };
}
function noteLinks(value: unknown): NoteLinkInput[] {
  if (!Array.isArray(value) || value.length > 500)
    throw new HttpError(400, 'INVALID_INPUT', 'Links must be a list of at most 500 targets');
  const links: NoteLinkInput[] = [];
  for (const valueLink of value) {
    if (
      !isRecord(valueLink) ||
      !isLinkTargetType(valueLink.targetType) ||
      typeof valueLink.targetId !== 'string'
    )
      throw new HttpError(400, 'INVALID_LINK', 'A linked target does not exist');
    links.push({
      targetType: valueLink.targetType,
      targetId: valueLink.targetId,
      ...(valueLink.relation === undefined
        ? {}
        : { relation: safeText(valueLink.relation, 'relation', 100) }),
    });
  }
  return links;
}
function replaceLinks(db: Database, id: string, value: unknown): void {
  if (value === undefined) return;
  const links = noteLinks(value);
  for (const l of links) {
    if (target(db, l.targetType, l.targetId).missing)
      throw new HttpError(400, 'INVALID_LINK', 'A linked target does not exist');
    safeText(l.relation ?? 'related', 'relation', 100);
  }
  const desired = new Set(
    links.map((l) => JSON.stringify([l.targetType, l.targetId, l.relation || 'related'])),
  );
  for (const valueOld of db.prepare('SELECT * FROM note_links WHERE note_id=?').all(id)) {
    const old = valueOld as unknown as NoteLinkRow;
    if (!desired.has(JSON.stringify([old.target_type, old.target_id, old.relation])))
      db.prepare('DELETE FROM note_links WHERE id=?').run(old.id);
  }
  for (const l of links)
    db.prepare(
      'INSERT OR IGNORE INTO note_links(id,note_id,target_type,target_id,relation) VALUES (?,?,?,?,?)',
    ).run(newId('link'), id, l.targetType, l.targetId, l.relation || 'related');
}
function validatedNoteOwner(db: Database, value: unknown): string {
  const owner = value === undefined ? 'patient' : safeText(value, 'ownerPersonId', 500);
  if (!owner || !db.prepare('SELECT id FROM people WHERE id=?').get(owner))
    throw new HttpError(400, 'INVALID_PERSON', 'The record owner does not exist in this profile.');
  return owner;
}
function personDisplayIdentities(db: Database, exceptId?: string): Set<string> {
  return new Set(
    (db.prepare("SELECT * FROM notes WHERE kind='person'").all() as NoteRow[])
      .filter((row) => row.id !== exceptId)
      .map((row) => {
        const person = storedPerson(row.profile_json);
        return personDisplayKey(row.title, person.icon);
      }),
  );
}
// Installed by the profile owner; validates Self against the login picker catalog.
const profileDisplayGuards = new WeakMap<Database, (name: string, icon?: string) => void>();
export function registerProfileDisplayGuard(
  db: Database,
  guard: (name: string, icon?: string) => void,
) {
  profileDisplayGuards.set(db, guard);
}
function requireDistinctPerson(
  db: Database,
  name: string,
  icon: string | undefined,
  row?: NoteRow,
): void {
  const identity = personDisplayKey(name, icon);
  // Keep legacy duplicates editable unless the identifying pair is changed.
  if (row) {
    const old = storedPerson(row.profile_json);
    if (identity === personDisplayKey(row.title, old.icon)) return;
  }
  if (row?.person_id === 'patient') profileDisplayGuards.get(db)?.(name, icon);
  if (personDisplayIdentities(db, row?.id).has(identity))
    throw new HttpError(
      409,
      'DUPLICATE_PERSON_DISPLAY',
      'Another person already has this display name and icon. Choose a different display name or icon.',
    );
}
function createInner(
  db: Database,
  input: NoteValues,
  preparedPerson?: { personId: string; icon?: string },
): string {
  const kind = input.kind ?? 'note';
  if (typeof kind !== 'string' || !['note', 'historical', 'person'].includes(kind))
    throw new HttpError(400, 'INVALID_INPUT', 'Unknown note kind');
  const v = validateInput(db, input, { profile_json: '{}' }),
    id = input.id === undefined ? newId('note') : safeText(input.id, 'id'),
    personId = kind === 'person' ? preparedPerson?.personId || newId('person') : null,
    t = now();
  if (personId) {
    const name = v.title;
    if (preparedPerson?.icon) v.person.icon = preparedPerson.icon;
    if (!v.person.icon) {
      const used = personDisplayIdentities(db);
      const choices = personIconCatalog.icons
        .map((icon) => `lucide:${icon.name}`)
        .filter((icon) => !used.has(personDisplayKey(name, icon)));
      if (!choices.length)
        throw new HttpError(
          409,
          'DUPLICATE_PERSON_DISPLAY',
          'Choose a different display name or a distinct emoji.',
        );
      v.person.icon = choices[randomInt(choices.length)]!;
    }
    requireDistinctPerson(db, name, v.person.icon);
  }
  if (personId)
    db.prepare('INSERT INTO people(id,display_name,relationship) VALUES(?,?,?)').run(
      personId,
      v.person.name || v.title,
      v.person.relationship || null,
    );
  db.prepare(
    'INSERT INTO notes(id,kind,status,title,content,note_type,event_date,topics,raw_thoughts,person_id,profile_json,text_formats_json,pinned,archived,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
  ).run(
    id,
    kind,
    kind === 'historical' ? 'draft' : 'editable',
    v.title,
    v.content,
    v.typeLabel,
    v.eventDate,
    v.topics,
    v.rawThoughts,
    personId,
    JSON.stringify(v.person),
    JSON.stringify(v.textFormats),
    v.pinned,
    v.archived,
    t,
    t,
  );
  replaceLinks(db, id, input.links);
  return id;
}
function editingOperation(
  input: NoteValues,
  operation: TransactionOperation = {},
): TransactionOperation {
  if (input.editingSessionId === undefined) return operation;
  if (
    typeof input.editingSessionId !== 'string' ||
    !/^[0-9a-f-]{36}$/i.test(input.editingSessionId)
  )
    throw new HttpError(400, 'INVALID_SESSION', 'Invalid editing session');
  return { ...operation, origin: { kind: 'note-editor', sessionId: input.editingSessionId } };
}
export function createNote(
  db: Database,
  value: unknown,
  afterSave?: (note: ReturnType<typeof getNote>) => void,
  operation?: TransactionOperation,
): Note {
  const input = objectInput(value);
  if (
    input.id !== undefined &&
    (typeof input.id !== 'string' || !/^note:[0-9a-f-]{36}$/i.test(input.id))
  )
    throw new HttpError(400, 'INVALID_ID', 'Note id must use note:<UUID>');
  if (input.id) {
    const existing = db.prepare('SELECT * FROM notes WHERE id=?').get(input.id) as
      NoteRow | undefined;
    if (existing) {
      const v = validateInput(db, input, { profile_json: '{}' });
      if (existing.kind === 'person' && !v.person.icon)
        v.person.icon = storedPerson(existing.profile_json).icon;
      const links = noteLinks(input.links || [])
        .map((l) => [l.targetType, l.targetId, l.relation || 'related'].join('\u0000'))
        .sort();
      const actual = db
        .prepare('SELECT * FROM note_links WHERE note_id=?')
        .all(existing.id)
        .map((valueLink) => {
          const link = valueLink as unknown as NoteLinkRow;
          return [link.target_type, link.target_id, link.relation].join('\u0000');
        })
        .sort();
      if (
        existing.kind !== (input.kind || 'note') ||
        (existing.kind !== 'person' &&
          String(storedPerson(existing.profile_json).recordOwnerPersonId || 'patient') !==
            validatedNoteOwner(db, input.ownerPersonId)) ||
        existing.title !== v.title ||
        existing.content !== v.content ||
        existing.note_type !== v.typeLabel ||
        existing.event_date !== v.eventDate ||
        existing.topics !== v.topics ||
        existing.raw_thoughts !== v.rawThoughts ||
        existing.profile_json !== JSON.stringify(v.person) ||
        existing.text_formats_json !== JSON.stringify(v.textFormats) ||
        existing.pinned !== v.pinned ||
        existing.archived !== v.archived ||
        JSON.stringify(links) !== JSON.stringify(actual)
      )
        throw new HttpError(
          409,
          'ID_CONFLICT',
          'This note id was already used; reload the saved note before changing it',
        );
      return getNote(db, existing.id);
    }
  }
  const id = transaction(
    db,
    () => {
      const created = createInner(db, input);
      afterSave?.(getNote(db, created));
      return created;
    },
    editingOperation(input, operation),
  );
  return getNote(db, id);
}
function saveInner(db: Database, row: NoteRow, input: NoteValues, manualNames = true): void {
  checkEditable(row, input.version);
  if (
    input.ownerPersonId !== undefined &&
    input.ownerPersonId !==
      (row.kind === 'person'
        ? row.person_id
        : String(storedPerson(row.profile_json).recordOwnerPersonId || 'patient'))
  )
    throw new HttpError(
      400,
      'NOTE_OWNER_IMMUTABLE',
      'Changing the view cannot reassign an existing note.',
    );
  if (input.kind && input.kind !== row.kind)
    throw new HttpError(400, 'INVALID_INPUT', 'Use the convert command to change note kind');
  const v = validateInput(db, input, row);
  if (manualNames && row.kind === 'person')
    rememberManualNameChanges(db, row.id, storedPerson(row.profile_json), v.person);
  if (row.person_id === 'patient') {
    if (
      v.person.onboarding?.completedSteps?.includes('medications') &&
      !storedPerson(row.profile_json).onboarding?.completedSteps?.includes('medications')
    )
      requireMedicationSetupReview(db);
    if ((Array.isArray(input.links) && input.links.length) || v.archived)
      throw new HttpError(
        400,
        'SELF_PROFILE',
        'Self already represents this profile. Add a linked note for annotations; Self cannot be archived or have outgoing links.',
      );
    const name = safeText(
      (isRecord(input.person) ? input.person.name : undefined) ??
        input.title ??
        selfIdentity(db).name,
      'display name',
      500,
    ).trim();
    if (!name) throw new HttpError(400, 'INVALID_INPUT', 'A display name is required');
    v.person = { ...v.person, name, relationship: 'Self' };
    v.title = name;
  }
  if (row.kind === 'person') requireDistinctPerson(db, v.title, v.person.icon, row);
  if (input.archived !== undefined) {
    const visibility = visibilityState(db, 'note', row.id);
    if (Boolean(input.archived) !== visibility.archived)
      throw new HttpError(
        400,
        'INVALID_INPUT',
        'Use Archive or Restore with the current visibility version',
      );
  }
  v.archived = row.archived;
  replaceLinks(db, row.id, input.links);
  db.prepare(
    'UPDATE notes SET title=?,content=?,note_type=?,event_date=?,topics=?,raw_thoughts=?,profile_json=?,text_formats_json=?,pinned=?,archived=?,updated_at=?,version=version+1 WHERE id=?',
  ).run(
    v.title,
    v.content,
    v.typeLabel,
    v.eventDate,
    v.topics,
    v.rawThoughts,
    JSON.stringify(v.person),
    JSON.stringify(v.textFormats),
    v.pinned,
    v.archived,
    now(),
    row.id,
  );
  if (row.person_id)
    db.prepare('UPDATE people SET display_name=?,relationship=? WHERE id=?').run(
      v.person.name || v.title,
      v.person.relationship || null,
      row.person_id,
    );
}

/** Identity-scope caller owns the existing durable workflow transaction. */
export function createIntakeFamilyPersonInTransaction(
  db: Database,
  fullName: string,
  relationship?: string,
  preparedPerson?: { noteId: string; personId: string; icon?: string },
) {
  if (
    preparedPerson &&
    (!/^note:[0-9a-f-]{36}$/i.test(preparedPerson.noteId) ||
      !/^person:[0-9a-f-]{36}$/i.test(preparedPerson.personId) ||
      db.prepare('SELECT 1 FROM notes WHERE id=?').get(preparedPerson.noteId) ||
      db.prepare('SELECT 1 FROM people WHERE id=?').get(preparedPerson.personId))
  )
    throw new HttpError(
      409,
      'IDENTITY_SELECTION',
      'The prepared family person destination changed',
    );
  const id = createInner(
    db,
    {
      ...(preparedPerson ? { id: preparedPerson.noteId } : {}),
      kind: 'person',
      title: fullName,
      content: '',
      person: {
        fullName,
        name: fullName,
        tags: ['Family'],
        ...(relationship ? { relationship } : {}),
      },
    },
    preparedPerson,
  );
  return getNote(db, id);
}

/** Explicit report-to-Self confirmation adds a name without replacing existing demographics. */
export function rememberSourceNameInTransaction(
  db: Database,
  noteId: string,
  evidence: NonNullable<PersonProfile['sourceKnownNames']>[number],
): string | undefined {
  const row = noteRow(db, noteId);
  const current = getNote(db, row.id);
  rememberNameSupport(db, noteId, current.person, evidence);
  const sources = current.person.sourceKnownNames || [];
  if (sources.some((source) => source.name === evidence.name)) return;
  if (sources.length >= 1024)
    throw new HttpError(
      409,
      'SOURCE_NAMES_CAPACITY',
      'This person has reached the retained source-name limit; no confirmation was saved',
    );
  const names = savedKnownNames(current.person.knownNames);
  const already = names.some(
    (known) => canonicalIdentityName(known) === canonicalIdentityName(evidence.name),
  );
  const next = already ? names : [...names, evidence.name];
  // Install the authority inside the caller's existing journal transaction,
  // then use ordinary save validation/versioning for the mirrored name list.
  db.prepare('UPDATE notes SET profile_json=? WHERE id=?').run(
    JSON.stringify({ ...current.person, sourceKnownNames: [...sources, evidence] }),
    row.id,
  );
  saveInner(
    db,
    noteRow(db, row.id),
    {
      version: row.version,
      person: { ...current.person, knownNames: next },
    },
    false,
  );
  return already ? undefined : evidence.name;
}

/** Used only by an existing outer transaction that also retains the identity receipt. */
export function updateBlankSelfIdentityFieldsInTransaction(
  db: Database,
  expectedVersion: number,
  fields: Pick<IntakeEvidencedIdentity, 'fullName' | 'birthDate'>,
): { versionBefore: number; versionAfter: number } {
  if (
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 1 ||
    !isRecord(fields) ||
    !Object.keys(fields).length ||
    Object.keys(fields).some((key) => !['fullName', 'birthDate'].includes(key)) ||
    Object.values(fields).some((value) => typeof value !== 'string' || !value.trim())
  )
    throw new HttpError(
      400,
      'SELF_IDENTITY_UPDATE',
      'Select one or both displayed blank Self identity fields',
    );
  const row = noteRow(db, 'patient');
  if (row.version !== expectedVersion)
    throw new HttpError(
      409,
      'SELF_VERSION_CONFLICT',
      'Self changed while identity was being reviewed; refresh before confirming',
    );
  const current = getNote(db, row.id);
  for (const key of Object.keys(fields) as ('fullName' | 'birthDate')[])
    if (typeof current.person[key] === 'string' && current.person[key]!.trim())
      throw new HttpError(
        409,
        'SELF_VERSION_CONFLICT',
        `Self ${key === 'fullName' ? 'full name' : 'date of birth'} is no longer blank`,
      );
  saveInner(db, row, {
    version: expectedVersion,
    person: { ...current.person, ...fields },
  });
  return { versionBefore: expectedVersion, versionAfter: getNote(db, row.id).version };
}

export function saveNote(
  db: Database,
  id: string,
  value: unknown,
  afterSave?: (note: ReturnType<typeof getNote>) => void,
  operation?: TransactionOperation,
): Note {
  const input = objectInput(value);
  const resolved = transaction(
    db,
    () => {
      const row = noteRow(db, id);
      saveInner(db, row, input);
      afterSave?.(getNote(db, row.id));
      return row.id;
    },
    editingOperation(input, operation),
  );
  return getNote(db, resolved);
}
export function convertNote(db: Database, id: string, value: unknown): Note {
  const input = objectInput(value);
  const resolved = transaction(db, () => {
    const row = noteRow(db, id);
    checkEditable(row, input.version);
    if (row.kind !== 'note')
      throw new HttpError(
        409,
        'INVALID_CONVERSION',
        'Only editable freeform notes can be converted',
      );
    db.prepare(
      "UPDATE notes SET kind='historical',status='draft',note_type=?,event_date=?,updated_at=?,version=version+1 WHERE id=?",
    ).run(
      normalizeType(db, input.typeLabel ?? row.note_type),
      optionalText(input.eventDate ?? row.event_date, 'eventDate', 100),
      now(),
      row.id,
    );
    return row.id;
  });
  return getNote(db, resolved);
}
export function finishNote(
  db: Database,
  id: string,
  value: unknown,
  checkAssets?: (noteId: string) => void,
): Note {
  const input = objectInput(value);
  const resolved = transaction(db, () => {
    const row = noteRow(db, id);
    if (row.kind !== 'historical')
      throw new HttpError(409, 'INVALID_NOTE_KIND', 'Only historical drafts can be finished');
    if (
      typeof input.title !== 'string' ||
      typeof input.content !== 'string' ||
      !Array.isArray(input.links)
    )
      throw new HttpError(
        400,
        'INVALID_INPUT',
        'Finish requires the current title, content, links and version',
      );
    saveInner(db, row, input);
    checkAssets?.(row.id);
    db.prepare("UPDATE notes SET status='finished',finished_at=?,updated_at=? WHERE id=?").run(
      now(),
      now(),
      row.id,
    );
    return row.id;
  });
  return getNote(db, resolved);
}
export function correctionNote(db: Database, id: string, value: unknown): Note {
  const input = objectInput(value);
  const original = noteRow(db, id);
  return createNote(db, {
    id: input.id,
    kind: 'historical',
    ownerPersonId: String(storedPerson(original.profile_json).recordOwnerPersonId || 'patient'),
    title: input.title || 'Correction: ' + original.title,
    content: input.content || '',
    typeLabel: original.note_type,
    links: [{ targetType: 'note', targetId: original.id, relation: 'corrects' }],
  });
}
export function personTags(db: Database): string[] {
  const tags = new Set<string>(PERSON_TAG_SUGGESTIONS);
  for (const row of db
    .prepare(
      "SELECT profile_json FROM notes WHERE kind='person' AND person_id <> 'patient' AND archived=0",
    )
    .all()) {
    const recorded = storedPerson(row.profile_json).tags;
    if (!Array.isArray(recorded)) continue;
    // A malformed older personal field must not make all filter options fail.
    for (const value of recorded)
      if (typeof value === 'string') {
        try {
          for (const tag of normalizePersonTags([value])) tags.add(tag);
        } catch {
          /* Leave unrecognized stored data untouched. */
        }
      }
  }
  return [
    ...PERSON_TAG_SUGGESTIONS,
    ...[...tags].filter((tag) => !PERSON_TAG_SUGGESTIONS.some((item) => item === tag)).sort(),
  ];
}
export function typeLabels(db: Database): string[] {
  return [
    ...new Set([
      'Therapy',
      'Primary care',
      'Specialist',
      ...db
        .prepare(
          'SELECT DISTINCT note_type FROM notes WHERE note_type IS NOT NULL ORDER BY note_type',
        )
        .all()
        .map((r) => String(r.note_type)),
    ]),
  ];
}
export function linkTarget(db: Database, type: unknown, id: unknown): ResolvedLinkTarget {
  if (!isLinkTargetType(type) || typeof id !== 'string')
    throw new HttpError(400, 'INVALID_LINK', 'Choose a supported link type and ID');
  const resolved = target(db, type, id);
  if (resolved.missing) throw new HttpError(404, 'NOT_FOUND', 'Linked record not found');
  return { targetType: type, targetId: id, ...resolved };
}
export function relatedNotes(db: Database, type: LinkTargetType, id: string) {
  linkTarget(db, type, id);
  // A note/person can have two stable addresses; collect both without implying
  // that every record in the profile is a personal annotation of Self.
  const clinicalKinds = clinicalReferenceKinds(db, type, id);
  let aliases: string[][] = clinicalKinds.length
    ? clinicalReferenceAliases(db, type, id)
    : [[type, id]];
  if (type === 'note' || type === 'person') {
    const r = db.prepare('SELECT id,person_id FROM notes WHERE id=? OR person_id=?').get(id, id) as
      Pick<NoteRow, 'id' | 'person_id'> | undefined;
    if (r) aliases = [['note', r.id], ...(r.person_id ? [['person', r.person_id]] : [])];
  }
  const where = aliases.map(() => '(l.target_type=? AND l.target_id=?)').join(' OR ');
  return db
    .prepare(
      `SELECT n.*,group_concat(l.relation, ', ') AS relations,${clinicalKinds.length ? 'MAX(CASE WHEN l.target_id<>? THEN 1 ELSE 0 END)' : '0'} AS ownership_redirect FROM notes n JOIN note_links l ON l.note_id=n.id WHERE ${where} GROUP BY n.id ORDER BY n.updated_at DESC,n.id`,
    )
    .all(
      ...(clinicalKinds.length ? [resolveClinicalReference(db, type, id)!.recordId] : []),
      ...aliases.flat(),
    )
    .map((valueRow) => {
      const r = valueRow as RelatedNoteRow;
      return {
        id: r.id,
        title: r.title,
        content: r.content,
        textFormats: storedTextFormats(r.text_formats_json),
        kind: r.kind,
        status: r.status,
        archived: visibilityState(db, 'note', r.id).archived,
        typeLabel: r.note_type,
        updatedAt: managedTimestamp(r.updated_at),
        relations: r.relations,
        ownerPersonId:
          r.kind === 'person'
            ? r.person_id || 'patient'
            : String(storedPerson(r.profile_json).recordOwnerPersonId || 'patient'),
        ownershipRedirect: !!r.ownership_redirect,
        attachmentCount:
          db
            .prepare(
              "SELECT count(*) AS n FROM attachments WHERE (owner_type='note' AND owner_id=?) OR (owner_type='person' AND owner_id=?)",
            )
            .get(r.id, r.person_id || '')?.n ?? 0,
      };
    });
}
export function linkTargets(db: Database, params: URLSearchParams): LinkTarget[] {
  const q = '%' + (params.get('q') || '') + '%';
  const filter = params.get('type') || '';
  if (filter && !isLinkTargetType(filter))
    throw new HttpError(400, 'INVALID_LINK_TYPE', 'Unknown link type');
  const limit = Math.min(200, Math.max(1, Number(params.get('limit')) || 50));
  const out: LinkTarget[] = [];
  if (!filter || filter === 'note' || filter === 'person') {
    const kinds =
      filter === 'person' ? " AND kind='person'" : filter === 'note' ? " AND kind!='person'" : '';
    for (const valueRow of db
      .prepare(
        `SELECT * FROM notes WHERE (title LIKE ? OR content LIKE ? OR profile_json LIKE ? OR (kind='person' AND person_id='patient' AND EXISTS(SELECT 1 FROM people WHERE id='patient' AND display_name LIKE ?)))${kinds} ORDER BY archived,title LIMIT ?`,
      )
      .all(q, q, q, q, limit)) {
      const r = valueRow as unknown as NoteRow;
      out.push({
        targetType: r.kind === 'person' ? 'person' : 'note',
        targetId: r.person_id || r.id,
        title: displayTitle(db, r),
        subtitle:
          r.kind === 'historical' ? (r.note_type || 'Historical note') + ' · ' + r.status : r.kind,
        archived: visibilityState(db, 'note', r.id).archived,
      });
    }
  }
  for (const [table, type, col, sub] of [
    ['observations', 'observation', 'label', 'effective_at'],
    ['test_types', 'test_type', 'label', 'unit'],
    ['medications', 'medication', 'label', 'kind'],
    ['procedures', 'procedure', 'label', 'effective_at'],
    ['source_files', 'source', 'path', 'coverage_status'],
    ['documents', 'document', 'title', 'effective_at'],
  ]) {
    if (filter && filter !== type) continue;
    for (const valueRow of db
      .prepare(
        `SELECT id,${col} AS title,${sub} AS subtitle FROM ${table} WHERE ${col} LIKE ? ORDER BY ${col},id LIMIT ?`,
      )
      .all(q, limit)) {
      const r = valueRow as unknown as LinkSearchRow;
      out.push({
        targetType: type as LinkTargetType,
        targetId: r.id,
        title: r.title,
        subtitle: r.subtitle,
        archived: visibilityState(db, type === 'source' ? 'source_file' : type, r.id).archived,
      });
    }
  }
  return out.slice(0, limit);
}
function validatePerson(person: Record<string, unknown>, previous: Record<string, unknown>): void {
  if (person.icon != null && !validPersonIcon(person.icon))
    throw new HttpError(400, 'INVALID_INPUT', 'Choose a person icon or a single emoji');
  const protectedNames = Array.isArray(person.sourceKnownNames)
    ? (person.sourceKnownNames as NonNullable<PersonProfile['sourceKnownNames']>)
    : [];
  const aliasError =
    knownNamesError(person.knownNames, 1056) ||
    knownNamesError(
      Array.isArray(person.knownNames)
        ? person.knownNames.filter(
            (name) =>
              typeof name !== 'string' ||
              !protectedNames.some(
                (source) => canonicalIdentityName(source.name) === canonicalIdentityName(name),
              ),
          )
        : person.knownNames,
    );
  if (aliasError) throw new HttpError(400, 'INVALID_INPUT', aliasError);
  const bloodTypes = ['', 'unknown', 'Unknown', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
  if (
    person.bloodType != null &&
    (typeof person.bloodType !== 'string' || !bloodTypes.includes(person.bloodType)) &&
    person.bloodType !== previous.bloodType
  )
    throw new HttpError(400, 'INVALID_INPUT', 'Choose a blood type or Unknown');
  if (
    person.lifeStatus != null &&
    (typeof person.lifeStatus !== 'string' ||
      !['alive', 'deceased', 'unknown'].includes(person.lifeStatus))
  )
    throw new HttpError(400, 'INVALID_INPUT', 'Choose alive, deceased, or unknown');
  for (const key of ['birthDate', 'deathDate']) {
    const value = person[key];
    if (value == null || value === '') continue;
    if (typeof value !== 'string') throw new HttpError(400, 'INVALID_INPUT', `${key} must be text`);
    if (value.toLowerCase() === 'unknown') continue;
    if (!/^\d{4}(-\d{2})?(-\d{2})?$/.test(value))
      throw new HttpError(
        400,
        'INVALID_INPUT',
        `${key} must be YYYY, YYYY-MM, YYYY-MM-DD, or unknown`,
      );
    const [y, m, d] = value.split('-').map(Number);
    if (
      y < 1 ||
      (m !== undefined && (m < 1 || m > 12)) ||
      (d !== undefined && (d < 1 || d > new Date(Date.UTC(y, m, 0)).getUTCDate()))
    )
      throw new HttpError(400, 'INVALID_INPUT', `${key} is not a valid calendar date`);
  }
}
