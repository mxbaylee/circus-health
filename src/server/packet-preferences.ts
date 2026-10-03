import { createHash } from 'node:crypto';
import {
  clinicalReferenceAliases,
  clinicalTables,
  resolveClinicalReference,
} from './clinical-references.ts';
import { HttpError, now, transaction, type Database } from './database.ts';
import { recordOwner } from './record-owner.ts';
import { sourceAssertionOwnership } from './source-assertion-ownership.ts';

import type { PacketRecordRef } from '../shared/packet-selection.ts';
export type { PacketRecordRef } from '../shared/packet-selection.ts';
export interface PacketPreference {
  personId: string;
  record: PacketRecordRef;
  alwaysWithhold: boolean;
  /** Explicitly assigned by the profile user; never a sensitivity inference. */
  tags: string[];
  version: number;
  actor: 'profile-user';
  updatedAt: string | null;
}
export interface PacketPreferenceInput {
  record: PacketRecordRef;
  alwaysWithhold: boolean;
  tags: string[];
  expectedVersion: number;
  operationId?: string;
}
/** Additional packet-candidate membership for originals and represented sources. */
export type PacketMembershipValidator = (
  db: Database,
  personId: string,
  record: PacketRecordRef,
) => boolean;
export interface PacketPreferenceOptions {
  validateMembership?: PacketMembershipValidator;
}
export const PACKET_PREFERENCE_PREFIX = 'packet_preference:v1:';
function invalid(message: string): never {
  throw new HttpError(400, 'INVALID_PACKET_PREFERENCE', message);
}
function identity(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value || value.length > 256 || /[\x00-\x1f\x7f]/u.test(value))
    invalid('Invalid packet record identity');
}
function checkedRef(ref: PacketRecordRef): PacketRecordRef {
  // Portable recovery can reach this module while clinical references are
  // initializing. Consult their supported kinds only when validating a request.
  if (
    !ref ||
    (!['note', 'source', 'source_file'].includes(ref.kind) &&
      !Object.hasOwn(clinicalTables, ref.kind))
  )
    invalid('Unsupported packet record kind');
  identity(ref.recordId);
  return { kind: ref.kind, recordId: ref.recordId };
}
function normalizedTags(tags: unknown): string[] {
  if (!Array.isArray(tags) || tags.length > 32) invalid('Use at most 32 person-applied tags');
  return [
    ...new Set(
      tags.map((tag: unknown) => {
        if (
          typeof tag !== 'string' ||
          !tag.trim() ||
          tag.trim().length > 80 ||
          /[\x00-\x1f\x7f]/u.test(tag)
        )
          invalid('Each tag must contain 1 to 80 printable characters');
        return tag.trim();
      }),
    ),
  ].sort();
}
function requirePerson(db: Database, personId: string) {
  identity(personId);
  if (!db.prepare('SELECT 1 FROM people WHERE id=?').get(personId))
    throw new HttpError(404, 'NOT_FOUND', 'Person not found');
}
function scopeError(): never {
  throw new HttpError(
    404,
    'PACKET_RECORD_NOT_FOUND',
    'Record is not available for this person’s packet',
  );
}

/** Current classification is accepted evidence; record IDs alone do not authorize access. */
export function resolvePacketRecord(
  db: Database,
  personId: string,
  input: PacketRecordRef,
  options: PacketPreferenceOptions = {},
): PacketRecordRef {
  requirePerson(db, personId);
  const ref = checkedRef(input);
  const resolved = resolveClinicalReference(db, ref.kind, ref.recordId);
  const current = resolved ? { kind: resolved.kind, recordId: resolved.recordId } : ref;
  if (current.kind === 'source' || current.kind === 'source_file') {
    const table = current.kind === 'source' ? 'source_records' : 'source_files';
    if (!db.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(current.recordId)) scopeError();
    const explicit =
      current.kind === 'source' &&
      sourceAssertionOwnership(db, current.recordId).ownerPersonId === personId;
    if (!explicit && options.validateMembership?.(db, personId, current) !== true) scopeError();
  } else {
    if (
      current.kind === 'note' &&
      !db.prepare("SELECT 1 FROM notes WHERE id=? AND kind<>'person'").get(current.recordId)
    )
      scopeError();
    if (recordOwner(db, current.kind, current.recordId) !== personId) scopeError();
  }
  return current;
}
const sharedSource = (record: PacketRecordRef) =>
  record.kind === 'source' || record.kind === 'source_file';
export function packetPreferenceKey(personId: string, record: PacketRecordRef): string {
  const family = Object.hasOwn(clinicalTables, record.kind) ? 'clinical' : record.kind;
  // Clinical/note identity has one current owner. Originals may serve several
  // people concurrently, so their choices retain an explicit subject suffix.
  return `${PACKET_PREFERENCE_PREFIX}${family}:${encodeURIComponent(record.recordId)}${sharedSource(record) ? `:${encodeURIComponent(personId)}` : ''}`;
}
/** Portable readers validate the new field before overlaying it on older curation. */
export function validatePacketPreferenceRows(
  rows: unknown,
): asserts rows is Array<{ key: string; value: string }> {
  if (!Array.isArray(rows)) invalid('Invalid stored packet preferences');
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row.key !== 'string' || typeof row.value !== 'string' || seen.has(row.key))
      invalid('Invalid stored packet preference');
    seen.add(row.key);
    const stored = decode(row.value);
    if (row.key !== packetPreferenceKey(stored.personId, stored.record))
      invalid('Invalid stored packet preference identity');
  }
}
function decode(text: string): PacketPreference {
  let value: PacketPreference;
  try {
    value = JSON.parse(text) as PacketPreference;
  } catch {
    return invalid('Invalid stored packet preference');
  }
  if (!value || typeof value !== 'object') invalid('Invalid stored packet preference');
  identity(value.personId);
  checkedRef(value.record);
  if (
    typeof value.alwaysWithhold !== 'boolean' ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    value.actor !== 'profile-user' ||
    typeof value.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.updatedAt)) ||
    JSON.stringify(normalizedTags(value.tags)) !== JSON.stringify(value.tags)
  )
    invalid('Invalid stored packet preference');
  return value;
}
function lookup(
  db: Database,
  personId: string,
  record: PacketRecordRef,
  inventory?: Map<string, PacketPreference>,
): { keys: string[]; preference: PacketPreference } | undefined {
  const clinical = Object.hasOwn(clinicalTables, record.kind);
  const aliases = clinical
    ? clinicalReferenceAliases(db, record.kind, record.recordId).map(([, id]) => id!)
    : [record.recordId];
  const ids = [...new Set(aliases)];
  if (ids.length > 64) invalid('Packet preference identity has more than 64 joined records');
  const values = ids.flatMap((recordId) => {
    const key = packetPreferenceKey(personId, { ...record, recordId });
    const raw = inventory
      ? undefined
      : db.prepare('SELECT value FROM app_meta WHERE key=?').get(key)?.value;
    const preference = inventory
      ? inventory.get(key)
      : raw === undefined
        ? undefined
        : decode(String(raw));
    if (!preference) return [];
    if (packetPreferenceKey(preference.personId, preference.record) !== key)
      invalid('Invalid stored packet preference identity');
    if (clinical) {
      const resolved = resolveClinicalReference(
        db,
        preference.record.kind,
        preference.record.recordId,
      );
      if (resolved?.kind !== record.kind || resolved.recordId !== record.recordId)
        invalid('Packet preference classification does not match accepted identity');
    }
    return [{ key, preference }];
  });
  if (!values.length) return undefined;
  if (values.length > 64) invalid('Packet preference identity has more than 64 joined choices');
  const version = values.reduce((sum, value) => sum + value.preference.version, 0);
  if (!Number.isSafeInteger(version)) invalid('Invalid combined packet preference version');
  const tags = [
    ...new Set(
      values
        .filter(({ preference }) => preference.personId === personId)
        .flatMap(({ preference }) => preference.tags),
    ),
  ].sort();
  // Joining identities is conservative. An explicit current-owner save resolves
  // their combined choices; former-owner tags never cross the person boundary.
  return {
    keys: values.map(({ key }) => key),
    preference: {
      personId,
      record,
      alwaysWithhold: values.some(({ preference }) => preference.alwaysWithhold),
      tags,
      version,
      actor: 'profile-user',
      updatedAt: values
        .map(({ preference }) => preference.updatedAt!)
        .sort()
        .at(-1)!,
    },
  };
}
function defaults(personId: string, record: PacketRecordRef): PacketPreference {
  return {
    personId,
    record,
    alwaysWithhold: false,
    tags: [],
    version: 0,
    actor: 'profile-user',
    updatedAt: null,
  };
}
export function readPacketPreference(
  db: Database,
  personId: string,
  ref: PacketRecordRef,
  options: PacketPreferenceOptions = {},
): PacketPreference {
  const record = resolvePacketRecord(db, personId, ref, options);
  return lookup(db, personId, record)?.preference ?? defaults(personId, record);
}
export function readPacketPreferences(
  db: Database,
  personId: string,
  options: PacketPreferenceOptions = {},
): PacketPreference[] {
  requirePerson(db, personId);
  const rows = db
    .prepare('SELECT key,value FROM app_meta WHERE substr(key,1,?)=? ORDER BY key')
    .all(PACKET_PREFERENCE_PREFIX.length, PACKET_PREFERENCE_PREFIX);
  const inventory = new Map<string, PacketPreference>();
  for (const row of rows) {
    const stored = decode(String(row.value));
    if (packetPreferenceKey(stored.personId, stored.record) !== row.key)
      invalid('Invalid stored packet preference identity');
    inventory.set(String(row.key), stored);
  }
  const found = new Map<string, PacketPreference>();
  for (const stored of inventory.values()) {
    if (sharedSource(stored.record) && stored.personId !== personId) continue;
    let record: PacketRecordRef;
    try {
      record = resolvePacketRecord(db, personId, stored.record, options);
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) continue;
      throw error;
    }
    const key = packetPreferenceKey(personId, record);
    if (!found.has(key)) found.set(key, lookup(db, personId, record, inventory)!.preference);
  }
  return [...found.values()].sort((a, b) =>
    packetPreferenceKey(personId, a.record).localeCompare(packetPreferenceKey(personId, b.record)),
  );
}
export function writePacketPreference(
  db: Database,
  personId: string,
  input: PacketPreferenceInput,
  options: PacketPreferenceOptions = {},
): PacketPreference {
  if (
    !input ||
    typeof input.alwaysWithhold !== 'boolean' ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 0
  )
    invalid('Supply packet choices and their expected version');
  if (input.operationId !== undefined && !/^[0-9a-f-]{36}$/.test(input.operationId))
    invalid('Invalid operation ID');
  const tags = normalizedTags(input.tags);
  const record = resolvePacketRecord(db, personId, input.record, options);
  const current = lookup(db, personId, record)?.preference ?? defaults(personId, record);
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        personId,
        record: checkedRef(input.record),
        alwaysWithhold: input.alwaysWithhold,
        tags,
        expectedVersion: input.expectedVersion,
      }),
    )
    .digest('hex');
  const retainedOperation =
    input.operationId !== undefined &&
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='__record_transactions'")
      .get()
      ? db
          .prepare('SELECT 1 FROM __record_transactions WHERE operation_id=?')
          .get(input.operationId)
      : undefined;
  if (
    !retainedOperation &&
    current.version === input.expectedVersion &&
    current.alwaysWithhold === input.alwaysWithhold &&
    JSON.stringify(current.tags) === JSON.stringify(tags)
  )
    return current;
  return transaction(
    db,
    () => {
      resolvePacketRecord(db, personId, input.record, options);
      const retained = lookup(db, personId, record);
      const before = retained?.preference ?? defaults(personId, record);
      if (before.version !== input.expectedVersion)
        throw new HttpError(
          409,
          'VERSION_CONFLICT',
          'Packet preference changed; reload before saving',
        );
      if (!Number.isSafeInteger(before.version + 1)) invalid('Packet preference version exhausted');
      const next: PacketPreference = {
        personId,
        record,
        alwaysWithhold: input.alwaysWithhold,
        tags,
        version: before.version + 1,
        actor: 'profile-user',
        updatedAt: now(),
      };
      const key = packetPreferenceKey(personId, record);
      for (const old of retained?.keys ?? [])
        if (old !== key) db.prepare('DELETE FROM app_meta WHERE key=?').run(old);
      db.prepare(
        'INSERT INTO app_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      ).run(key, JSON.stringify(next));
      return next;
    },
    {
      actor: 'profile-user',
      origin: 'packet-preference',
      ...(input.operationId === undefined ? {} : { operationId: input.operationId, fingerprint }),
    },
  );
}
