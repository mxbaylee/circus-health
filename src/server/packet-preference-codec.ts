// Pure storage codec: portable recovery must not import domain queries or model services.
import type { PacketRecordRef } from '../shared/packet-selection.ts';

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
export const PACKET_PREFERENCE_PREFIX = 'packet_preference:v1:';
// These are the classifications supported by the v1 packet preference contract.
const clinicalKinds = new Set(['observation', 'medication', 'procedure', 'document']);
type PreferenceFailure = (message: string) => never;
function invalidPreference(message: string): never {
  throw new Error(message);
}
export function packetPreferenceIdentity(
  value: unknown,
  invalid: PreferenceFailure = invalidPreference,
): asserts value is string {
  if (typeof value !== 'string' || !value || value.length > 256 || /[\x00-\x1f\x7f]/u.test(value))
    invalid('Invalid packet record identity');
}
export function packetPreferenceRef(
  ref: PacketRecordRef,
  invalid: PreferenceFailure = invalidPreference,
): PacketRecordRef {
  if (
    !ref ||
    (!['note', 'source', 'source_file'].includes(ref.kind) && !clinicalKinds.has(ref.kind))
  )
    invalid('Unsupported packet record kind');
  packetPreferenceIdentity(ref.recordId, invalid);
  return { kind: ref.kind, recordId: ref.recordId };
}
export function normalizePacketTags(
  tags: unknown,
  invalid: PreferenceFailure = invalidPreference,
): string[] {
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
const sharedSource = (record: PacketRecordRef) =>
  record.kind === 'source' || record.kind === 'source_file';
export function packetPreferenceKey(personId: string, record: PacketRecordRef): string {
  const family = clinicalKinds.has(record.kind) ? 'clinical' : record.kind;
  // Clinical/note identity has one current owner. Originals may serve several
  // people concurrently, so their choices retain an explicit subject suffix.
  return `${PACKET_PREFERENCE_PREFIX}${family}:${encodeURIComponent(record.recordId)}${sharedSource(record) ? `:${encodeURIComponent(personId)}` : ''}`;
}
/** Portable readers validate the new field before overlaying it on older curation. */
export function validatePacketPreferenceRows(
  rows: unknown,
  invalid: PreferenceFailure = invalidPreference,
): asserts rows is Array<{ key: string; value: string }> {
  if (!Array.isArray(rows)) invalid('Invalid stored packet preferences');
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row.key !== 'string' || typeof row.value !== 'string' || seen.has(row.key))
      invalid('Invalid stored packet preference');
    seen.add(row.key);
    const stored = decodePacketPreference(row.value, invalid);
    if (row.key !== packetPreferenceKey(stored.personId, stored.record))
      invalid('Invalid stored packet preference identity');
  }
}
export function decodePacketPreference(
  text: string,
  invalid: PreferenceFailure = invalidPreference,
): PacketPreference {
  let value: PacketPreference;
  try {
    value = JSON.parse(text) as PacketPreference;
  } catch {
    return invalid('Invalid stored packet preference');
  }
  if (!value || typeof value !== 'object') invalid('Invalid stored packet preference');
  packetPreferenceIdentity(value.personId, invalid);
  packetPreferenceRef(value.record, invalid);
  if (
    typeof value.alwaysWithhold !== 'boolean' ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    value.actor !== 'profile-user' ||
    typeof value.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.updatedAt)) ||
    JSON.stringify(normalizePacketTags(value.tags, invalid)) !== JSON.stringify(value.tags)
  )
    invalid('Invalid stored packet preference');
  return value;
}
