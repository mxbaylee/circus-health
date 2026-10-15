import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { HttpError } from './database.ts';
/** Detached bounded presentation only. This never grants confirmation authority. */
import type { DatabaseSync } from 'node:sqlite';
import type { IntakeIdentityReview } from '../shared/intake-identity.ts';
import { observeDatabaseClose } from './database.ts';
import { reviewReadStamp } from './intake-clinical-review-read-cache.ts';
const MAX_ENTRIES = 32,
  MAX_BYTES = 256 * 1024;
const previews = new WeakMap<
  DatabaseSync,
  Map<string, { stamp: string; text: string; bytes: number }>
>();
const epochs = new WeakMap<DatabaseSync, object>();
const observed = new WeakSet<DatabaseSync>();
const fragmentKeys = new WeakMap<DatabaseSync, Buffer>();
export interface NativeIdentityFragmentPosition {
  offset: number;
  after: string | null;
  skip: number;
}
function fragmentCursorFailure(): never {
  throw new HttpError(409, 'IDENTITY_SCOPE_CURSOR', 'Reload this identity evidence fragment');
}
function fragmentPosition(value: unknown): value is NativeIdentityFragmentPosition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const p = value as NativeIdentityFragmentPosition;
  return (
    Object.keys(p).sort().join(',') === 'after,offset,skip' &&
    Number.isSafeInteger(p.offset) &&
    p.offset >= 0 &&
    (p.after === null || (typeof p.after === 'string' && /^[0-9]{16}$/.test(p.after))) &&
    Number.isSafeInteger(p.skip) &&
    p.skip >= 0 &&
    p.skip < 4096
  );
}
/** Presentation continuation only; no evidence or confirmation authority is minted. */
export function sealNativeIdentityFragmentCursor(
  db: DatabaseSync,
  epoch: object,
  binding: string,
  position: NativeIdentityFragmentPosition,
): string {
  if (
    !db.isOpen ||
    db.isTransaction ||
    !nativeIdentityPreviewCurrent(db, epoch) ||
    !/^[a-f0-9]{64}$/.test(binding) ||
    !fragmentPosition(position)
  )
    fragmentCursorFailure();
  let key = fragmentKeys.get(db);
  if (!key) {
    key = randomBytes(32);
    fragmentKeys.set(db, key);
  }
  const text = JSON.stringify(['health-intake-identity-fragment-v1', binding, position]);
  return (
    Buffer.from(text).toString('base64url') +
    '.' +
    createHmac('sha256', key).update(text).digest('hex')
  );
}
export function openNativeIdentityFragmentCursor(
  db: DatabaseSync,
  epoch: object,
  binding: string,
  cursor: string,
  offset: number,
): NativeIdentityFragmentPosition {
  const key = fragmentKeys.get(db);
  if (
    !db.isOpen ||
    db.isTransaction ||
    !nativeIdentityPreviewCurrent(db, epoch) ||
    !key ||
    typeof cursor !== 'string' ||
    cursor.length > 2048
  )
    fragmentCursorFailure();
  const match = /^([A-Za-z0-9_-]+)\.([a-f0-9]{64})$/.exec(cursor);
  if (!match) fragmentCursorFailure();
  const bytes = Buffer.from(match[1]!, 'base64url');
  if (bytes.toString('base64url') !== match[1]) fragmentCursorFailure();
  const expected = createHmac('sha256', key).update(bytes).digest();
  if (!timingSafeEqual(expected, Buffer.from(match[2]!, 'hex'))) fragmentCursorFailure();
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    fragmentCursorFailure();
  }
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value[0] !== 'health-intake-identity-fragment-v1' ||
    value[1] !== binding ||
    !fragmentPosition(value[2]) ||
    value[2].offset !== offset
  )
    fragmentCursorFailure();
  return value[2];
}
function observe(db: DatabaseSync) {
  if (observed.has(db)) return;
  observeDatabaseClose(db, () => {
    clearNativeIdentityPreviews(db);
    observed.delete(db);
  });
  observed.add(db);
}
export function nativeIdentityPreviewCounts(db: DatabaseSync) {
  const entries = previews.get(db);
  let bytes = 0;
  for (const entry of entries?.values() ?? []) bytes += entry.bytes;
  return { entries: entries?.size ?? 0, bytes };
}
export function beginNativeIdentityPreview(db: DatabaseSync) {
  observe(db);
  if (db.isTransaction) clearNativeIdentityPreviews(db);
  let epoch = epochs.get(db);
  if (!epoch) epochs.set(db, (epoch = {}));
  return epoch;
}
export function nativeIdentityPreviewCurrent(db: DatabaseSync, epoch: object) {
  return epochs.get(db) === epoch;
}
export function clearNativeIdentityPreviews(db: DatabaseSync) {
  fragmentKeys.get(db)?.fill(0);
  fragmentKeys.delete(db);
  previews.delete(db);
  epochs.set(db, {});
}
export function readNativeIdentityPreview(db: DatabaseSync, key: string) {
  const entries = previews.get(db),
    prior = entries?.get(key),
    stamp = reviewReadStamp(db);
  if (!prior) return undefined;
  if (stamp === undefined || prior.stamp !== stamp) {
    entries!.delete(key);
    return undefined;
  }
  entries!.delete(key);
  entries!.set(key, prior);
  return { stamp, value: decode(prior.text) };
}
function decode(text: string): IntakeIdentityReview {
  return JSON.parse(text, (_key, value, context) =>
    typeof value === 'number' && context?.source && JSON.stringify(value) !== context.source
      ? JSON.rawJSON(context.source)
      : value,
  ) as IntakeIdentityReview;
}
function fits(value: unknown, budget: { left: number }, depth = 0): boolean {
  if (depth > 100 || budget.left < 0) return false;
  if (typeof value === 'string') {
    budget.left -= Buffer.byteLength(value);
    return budget.left >= 0;
  }
  budget.left -= 8;
  if (!value || typeof value !== 'object') return budget.left >= 0;
  if (Array.isArray(value)) {
    for (const item of value) if (!fits(item, budget, depth + 1)) return false;
  } else {
    for (const key in value)
      if (Object.hasOwn(value, key)) {
        budget.left -= Buffer.byteLength(key);
        if (!fits((value as Record<string, unknown>)[key], budget, depth + 1)) return false;
      }
  }
  return budget.left >= 0;
}
/** Capture only after physical proof and owned-session cleanup have completed. */
export function retainNativeIdentityPreview(
  db: DatabaseSync,
  key: string,
  stamp: string | undefined,
  value: IntakeIdentityReview,
  epoch: object,
) {
  if (
    stamp === undefined ||
    !nativeIdentityPreviewCurrent(db, epoch) ||
    stamp !== reviewReadStamp(db) ||
    !fits(value, { left: MAX_BYTES })
  )
    return false;
  const text = JSON.stringify(value),
    bytes = Buffer.byteLength(text) + Buffer.byteLength(key);
  if (bytes > MAX_BYTES) return false;
  // Validate the emitted wire, never retain generators or caller-owned aliases.
  decode(text);
  if (!nativeIdentityPreviewCurrent(db, epoch) || stamp !== reviewReadStamp(db)) return false;
  let entries = previews.get(db);
  if (!entries) previews.set(db, (entries = new Map()));
  entries.delete(key);
  entries.set(key, { stamp, text, bytes });
  let total = [...entries.values()].reduce((size, entry) => size + entry.bytes, 0);
  while (entries.size > MAX_ENTRIES || total > MAX_BYTES) {
    const oldest = entries.keys().next().value!;
    total -= entries.get(oldest)!.bytes;
    entries.delete(oldest);
  }
  return entries.has(key);
}
