import {
  PACKET_PREFERENCE_PREFIX,
  packetPreferenceKey,
  packetPreferenceIdentity,
  packetPreferenceRef,
  normalizePacketTags,
  decodePacketPreference,
  validatePacketPreferenceRows as validateStoredPacketPreferenceRows,
  type PacketPreference,
} from './packet-preference-codec.ts';
export {
  PACKET_PREFERENCE_PREFIX,
  packetPreferenceKey,
  type PacketPreference,
} from './packet-preference-codec.ts';
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
function invalid(message: string): never {
  throw new HttpError(400, 'INVALID_PACKET_PREFERENCE', message);
}
export function validatePacketPreferenceRows(
  rows: unknown,
): asserts rows is Array<{ key: string; value: string }> {
  validateStoredPacketPreferenceRows(rows, invalid);
}
const identity = (value: unknown) => packetPreferenceIdentity(value, invalid);
const checkedRef = (ref: PacketRecordRef) => packetPreferenceRef(ref, invalid);
const normalizedTags = (tags: unknown) => normalizePacketTags(tags, invalid);
const decode = (text: string) => decodePacketPreference(text, invalid);
const sharedSource = (record: PacketRecordRef) =>
  record.kind === 'source' || record.kind === 'source_file';
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
