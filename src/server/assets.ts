import { createHash, randomUUID, type BinaryLike } from 'node:crypto';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import type { Asset, Attachment, AttachmentInput } from '../shared/api.ts';
import {
  mkdirSync,
  writeFileSync,
  renameSync,
  existsSync,
  realpathSync,
  readFileSync,
  statSync,
  openSync,
  closeSync,
  fsyncSync,
} from 'node:fs';
import { resolve, dirname, relative, isAbsolute, basename } from 'node:path';
import { HttpError, required, optionalText, safeText, now, transaction } from './database.ts';
import { assetDTO, attachmentDTO, noteRow, checkEditable, attachments } from './notes.ts';
import { validProfileId } from './profiles.ts';
import { existingProfileDatabase, safeRelative, ensureProfileOriginal } from './profile-storage.ts';
import { readProfileRegistry } from './profile-registry.ts';
type SqliteRow = Record<string, SQLOutputValue>;
type AttachmentOwnerType = Attachment['ownerType'];
type AssetMime = 'application/pdf' | 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

interface AssetRow extends SqliteRow {
  id: string;
  original_name: string;
  stored_path: string;
  mime_type: string;
  bytes: number;
  sha256: string;
  created_at: string;
  attribution: string;
}

interface AttachmentRow extends SqliteRow {
  id: string;
  asset_id: string;
  owner_type: AttachmentOwnerType;
  owner_id: string;
  caption: string;
  body_location: string | null;
  event_date: string | null;
  person_id: string | null;
  created_at: string;
}

type AttachmentUpdate = Partial<AttachmentInput> & { version?: number };

export const hash = (bytes: BinaryLike): string => createHash('sha256').update(bytes).digest('hex');
export function containedFile(root: string, path: string): string {
  const full = resolve(root, path),
    rel = relative(root, full);
  if (isAbsolute(path) || rel.startsWith('..') || isAbsolute(rel))
    throw new HttpError(400, 'INVALID_PATH', 'Invalid stored file path');
  if (!existsSync(full))
    throw new HttpError(404, 'MISSING_FILE', 'The original file is missing from local storage');
  const real = realpathSync(full),
    rootReal = realpathSync(root),
    actual = relative(rootReal, real);
  if (actual.startsWith('..') || isAbsolute(actual) || !statSync(real).isFile())
    throw new HttpError(400, 'INVALID_PATH', 'File is outside the archive');
  return real;
}
export function profileFile(
  root: string,
  path: unknown,
  profileId: string,
  verifiedDatabase?: DatabaseSync,
): string {
  if (!validProfileId(profileId) || !safeRelative(path))
    throw new HttpError(400, 'INVALID_PATH', 'Invalid stored file path');
  const modern = (p: string) =>
    p.startsWith(`data/profiles/${profileId}/sources/`) ||
    p.startsWith(`data/profiles/${profileId}/attachments/`);
  const boundary = () =>
    new HttpError(403, 'PROFILE_BOUNDARY', 'This file is outside the selected profile');
  if (modern(path)) {
    ensureProfileOriginal(root, path, profileId);
    const full = containedFile(root, path);
    if (!modern(relative(realpathSync(root), full))) throw boundary();
    return full;
  }
  // Historical providers/ is shared storage, never a blanket owner grant.
  // Every legacy file must be an exact checksummed reference in this owner's DB.
  if (!path.startsWith('providers/') && !path.startsWith(`data/attachments/${profileId}/`))
    throw boundary();
  if (
    profileId === 'cookie-dough' &&
    path.startsWith('providers/') &&
    !path.startsWith('providers/cookie-dough/')
  )
    throw boundary();
  const otherIds = new Set([
    'cookie-dough',
    ...(verifiedDatabase ? [] : readProfileRegistry(root).profiles.map((profile) => profile.id)),
  ]);
  if ([...otherIds].some((id) => id !== profileId && path.startsWith(`providers/${id}/`)))
    throw boundary();
  let db = verifiedDatabase,
    opened = false;
  try {
    if (!db) {
      if (!readProfileRegistry(root).profiles.some((profile) => profile.id === profileId))
        throw boundary();
      db = new DatabaseSync(existingProfileDatabase(root, profileId), { readOnly: true });
      opened = true;
    }
    if (
      db.prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'").get()?.value !==
      profileId
    )
      throw boundary();
    const reference = db
      .prepare(
        'SELECT sha256,bytes FROM source_files WHERE path=? UNION SELECT sha256,bytes FROM assets WHERE stored_path=?',
      )
      .all(path, path);
    if (
      !reference.length ||
      reference.some(
        (row) => row.sha256 !== reference[0]!.sha256 || row.bytes !== reference[0]!.bytes,
      )
    )
      throw boundary();
    const full = containedFile(root, path);
    // A symlink must not redirect an indexed legacy path to a different original.
    if (relative(realpathSync(root), full) !== path) throw boundary();
    const bytes = readFileSync(full);
    if (hash(bytes) !== reference[0]!.sha256 || bytes.length !== Number(reference[0]!.bytes))
      throw new HttpError(409, 'ASSET_INTEGRITY', 'The retained original has changed');
    return full;
  } finally {
    if (opened) db!.close();
  }
}

function syncFile(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function fileType(bytes: Buffer): AssetMime {
  if (bytes.subarray(0, 5).toString() === '%PDF-') return 'application/pdf';
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString())) return 'image/gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP')
    return 'image/webp';
  throw new HttpError(415, 'UNSUPPORTED_FILE', 'Choose a PDF, PNG, JPEG, GIF or WebP file');
}
export function uploadAsset(
  db: DatabaseSync,
  root: string,
  profileId: string,
  bytes: Buffer,
  name: unknown,
  declaredType: unknown,
): Asset {
  if (!bytes.length || bytes.length > 25 * 1024 * 1024)
    throw new HttpError(413, 'FILE_SIZE', 'Files must be between 1 byte and 25 MiB');
  const mime = fileType(bytes);
  if (declaredType !== mime)
    throw new HttpError(415, 'TYPE_MISMATCH', 'File contents do not match the declared type');
  const originalName = basename(safeText(name, 'filename', 500).replace(/\\/g, '/')).replace(
    /[\r\n\x00-\x1F]/g,
    '',
  );
  if (!originalName) throw new HttpError(400, 'INVALID_FILENAME', 'Filename is required');
  const sha = hash(bytes),
    id = 'asset:' + randomUUID(),
    extension = {
      'application/pdf': 'pdf',
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/gif': 'gif',
      'image/webp': 'webp',
    }[mime];
  const stored = `data/profiles/${profileId}/attachments/${sha}-${hash(Buffer.from(originalName)).slice(0, 12)}.${extension}`,
    full = resolve(root, stored);
  mkdirSync(dirname(full), { recursive: true });
  const existing = db
    .prepare('SELECT * FROM assets WHERE sha256=? AND bytes=? AND original_name=?')
    .get(sha, bytes.length, originalName) as AssetRow | undefined;
  if (existing) {
    if (hash(readFileSync(profileFile(root, existing.stored_path, profileId))) !== sha)
      throw new HttpError(409, 'ASSET_INTEGRITY', 'Existing original has changed');
    return assetDTO(existing);
  }
  if (existsSync(full)) {
    if (hash(readFileSync(profileFile(root, stored, profileId))) !== sha)
      throw new HttpError(409, 'ASSET_INTEGRITY', 'Stored asset does not match its hash');
  } else {
    const temp = full + '.' + randomUUID() + '.pending';
    writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 });
    syncFile(temp);
    renameSync(temp, full);
    syncFile(dirname(full));
  }
  // Files are immutable. A database failure may leave an unreferenced original, never a dangling indexed file.
  transaction(db, () => {
    db.prepare(
      'INSERT INTO assets(id,original_name,stored_path,mime_type,bytes,sha256,created_at) VALUES(?,?,?,?,?,?,?)',
    ).run(id, originalName, stored, mime, bytes.length, sha, now());
  });
  return assetDTO(required(db.prepare('SELECT * FROM assets WHERE id=?').get(id)));
}
function owner(db: DatabaseSync, type: AttachmentOwnerType, id: string, version?: number) {
  if (type === 'note' || type === 'person') {
    const row = noteRow(db, id);
    if (type === 'person' && row.person_id !== id)
      throw new HttpError(400, 'INVALID_OWNER', 'Use the stable person ID');
    checkEditable(row, version);
    return row;
  }
  const table = {
    observation: 'observations',
    medication: 'medications',
    procedure: 'procedures',
    document: 'documents',
  }[type];
  if (!table || !db.prepare(`SELECT id FROM ${table} WHERE id=?`).get(id))
    throw new HttpError(400, 'INVALID_OWNER', 'Attachment target does not exist');
  throw new HttpError(
    403,
    'READ_ONLY_RECORD',
    'Provider records are read-only. Add a comment with attachments instead.',
  );
}
function touch(db: DatabaseSync, row: { id: SQLOutputValue } | null | undefined): void {
  if (row)
    db.prepare('UPDATE notes SET version=version+1,updated_at=? WHERE id=?').run(now(), row.id);
}
function meta(input: AttachmentUpdate, row: Partial<AttachmentRow> = {}) {
  const personId = input.personId === undefined ? row.person_id : input.personId;
  return {
    caption: safeText(input.caption ?? row.caption ?? '', 'caption', 10000),
    body: optionalText(
      input.bodyLocation === undefined ? row.body_location : input.bodyLocation,
      'bodyLocation',
      1000,
    ),
    date: optionalText(
      input.eventDate === undefined ? row.event_date : input.eventDate,
      'eventDate',
      100,
    ),
    person: optionalText(personId, 'personId', 200),
  };
}
export function createAttachment(
  db: DatabaseSync,
  root: string,
  profileId: string,
  input: AttachmentInput,
): Attachment {
  if (
    input.id !== undefined &&
    (typeof input.id !== 'string' || !/^attachment:[0-9a-f-]{36}$/i.test(input.id))
  )
    throw new HttpError(400, 'INVALID_ID', 'Attachment id must use attachment:<UUID>');
  if (input.id) {
    const existing = db.prepare('SELECT * FROM attachments WHERE id=?').get(input.id) as
      AttachmentRow | undefined;
    if (existing) {
      const m = meta(input);
      if (
        existing.asset_id !== input.assetId ||
        existing.owner_type !== input.ownerType ||
        existing.owner_id !== input.ownerId ||
        existing.caption !== m.caption ||
        existing.body_location !== m.body ||
        existing.event_date !== m.date ||
        existing.person_id !== m.person
      )
        throw new HttpError(
          409,
          'ID_CONFLICT',
          'This attachment id was already used for a different association',
        );
      return attachmentDTO(db, existing);
    }
  }
  let id;
  transaction(db, () => {
    const row = owner(db, input.ownerType, input.ownerId, input.version),
      asset = required(
        db.prepare('SELECT * FROM assets WHERE id=?').get(input.assetId),
        'Asset not found',
      ) as AssetRow;
    profileFile(root, asset.stored_path, profileId);
    const m = meta(input);
    if (m.person && !db.prepare('SELECT id FROM people WHERE id=?').get(m.person))
      throw new HttpError(400, 'INVALID_PERSON', 'Linked person not found');
    id = input.id || 'attachment:' + randomUUID();
    db.prepare(
      'INSERT INTO attachments(id,asset_id,owner_type,owner_id,caption,body_location,event_date,person_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    ).run(id, asset.id, input.ownerType, input.ownerId, m.caption, m.body, m.date, m.person, now());
    touch(db, row);
  });
  return attachmentDTO(db, required(db.prepare('SELECT * FROM attachments WHERE id=?').get(id!)));
}
export function editAttachment(
  db: DatabaseSync,
  id: string,
  input: AttachmentUpdate,
  remove = false,
): Attachment | { deleted: true } {
  transaction(db, () => {
    const a = required(db.prepare('SELECT * FROM attachments WHERE id=?').get(id)) as AttachmentRow,
      row = owner(db, a.owner_type, a.owner_id, input.version);
    if (remove) db.prepare('DELETE FROM attachments WHERE id=?').run(id);
    else {
      const m = meta(input, a);
      if (m.person && !db.prepare('SELECT id FROM people WHERE id=?').get(m.person))
        throw new HttpError(400, 'INVALID_PERSON', 'Linked person not found');
      db.prepare(
        'UPDATE attachments SET caption=?,body_location=?,event_date=?,person_id=? WHERE id=?',
      ).run(m.caption, m.body, m.date, m.person, id);
    }
    touch(db, row);
  });
  return remove
    ? { deleted: true }
    : attachmentDTO(db, required(db.prepare('SELECT * FROM attachments WHERE id=?').get(id)));
}
export function verifyNoteAssets(
  db: DatabaseSync,
  root: string,
  profileId: string,
  id: string,
): void {
  for (const a of attachments(db, 'note', id)) {
    const r = required(db.prepare('SELECT * FROM assets WHERE id=?').get(a.assetId)) as AssetRow,
      path = profileFile(root, r.stored_path, profileId);
    if (hash(readFileSync(path)) !== r.sha256)
      throw new HttpError(
        409,
        'ASSET_INTEGRITY',
        'An attachment original is missing or changed; note was not finished',
      );
  }
}
