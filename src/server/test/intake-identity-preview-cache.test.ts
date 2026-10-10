import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type { IntakeIdentityReview } from '../../shared/intake-identity.ts';
import { reviewReadStamp } from '../intake-clinical-review-read-cache.ts';
import {
  beginNativeIdentityPreview,
  clearNativeIdentityPreviews,
  nativeIdentityPreviewCounts,
  nativeIdentityPreviewCurrent,
  readNativeIdentityPreview,
  retainNativeIdentityPreview,
} from '../intake-identity-preview-cache.ts';
function value(message = 'Inspect this fictional report'): IntakeIdentityReview {
  return {
    status: 'confirmation_required',
    blocking: true,
    message,
    scope: null,
    evidencedIdentity: { fullName: 'Fictional Preview Person' },
    self: { noteId: 'person-note:self', version: 1, fullName: null, birthDate: null },
    offeredSelfFields: {},
    conflicts: [],
  };
}
function retain(db: DatabaseSync, key = 'scope', review = value()) {
  return retainNativeIdentityPreview(
    db,
    key,
    reviewReadStamp(db),
    review,
    beginNativeIdentityPreview(db),
  );
}
test('identity preview wire is detached, exact and invalidated by SQL and transaction reads', () => {
  using db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE witness(value TEXT)');
  const review = value();
  review.self.version = JSON.rawJSON('12.00') as unknown as number;
  assert.equal(retain(db, 'scope', review), true);
  review.evidencedIdentity.fullName = 'Caller mutation';
  const first = readNativeIdentityPreview(db, 'scope')!;
  assert.equal(first.value.evidencedIdentity.fullName, 'Fictional Preview Person');
  assert.equal(JSON.stringify(first.value.self.version), '12.00');
  first.value.self.fullName = 'Another caller mutation';
  assert.equal(readNativeIdentityPreview(db, 'scope')!.value.self.fullName, null);
  db.prepare('INSERT INTO witness VALUES(?)').run('offpage same-count policy change');
  assert.equal(readNativeIdentityPreview(db, 'scope'), undefined);
  assert.equal(retain(db), true);
  db.exec('BEGIN');
  assert.equal(readNativeIdentityPreview(db, 'scope'), undefined);
  assert.equal(retain(db), false);
  db.exec('ROLLBACK');
  assert.equal(readNativeIdentityPreview(db, 'scope'), undefined);
});
test('identity preview lifecycle prevents late reseeding and observes actual close/reopen', () => {
  const db = new DatabaseSync(':memory:');
  const epoch = beginNativeIdentityPreview(db),
    stamp = reviewReadStamp(db);
  clearNativeIdentityPreviews(db);
  assert.equal(nativeIdentityPreviewCurrent(db, epoch), false);
  assert.equal(retainNativeIdentityPreview(db, 'late', stamp, value(), epoch), false);
  assert.equal(retain(db), true);
  db.close();
  assert.deepEqual(nativeIdentityPreviewCounts(db), { entries: 0, bytes: 0 });
  db.open();
  assert.equal(retain(db), true);
  db[Symbol.dispose]();
  assert.deepEqual(nativeIdentityPreviewCounts(db), { entries: 0, bytes: 0 });
});
test('identity preview serialization cannot certify a changed SQL stamp or lifecycle', () => {
  using db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE witness(value TEXT)');
  const epoch = beginNativeIdentityPreview(db),
    stamp = reviewReadStamp(db);
  const review = value();
  Object.defineProperty(review, 'toJSON', {
    value() {
      db.prepare('INSERT INTO witness VALUES(?)').run('during encoding');
      return value();
    },
  });
  assert.equal(retainNativeIdentityPreview(db, 'changed', stamp, review, epoch), false);
  const next = value(),
    current = beginNativeIdentityPreview(db),
    currentStamp = reviewReadStamp(db);
  Object.defineProperty(next, 'toJSON', {
    value() {
      clearNativeIdentityPreviews(db);
      return value();
    },
  });
  assert.equal(retainNativeIdentityPreview(db, 'cleared', currentStamp, next, current), false);
  assert.deepEqual(nativeIdentityPreviewCounts(db), { entries: 0, bytes: 0 });
});
test('identity preview retains at most 32 complete wires and 256KiB including keys', () => {
  using db = new DatabaseSync(':memory:');
  for (let i = 0; i < 40; i++) assert.equal(retain(db, String(i)), true);
  assert.equal(nativeIdentityPreviewCounts(db).entries, 32);
  assert.equal(readNativeIdentityPreview(db, '0'), undefined);
  clearNativeIdentityPreviews(db);
  for (let i = 0; i < 12; i++) assert.equal(retain(db, String(i), value('x'.repeat(40000))), true);
  assert.ok(nativeIdentityPreviewCounts(db).bytes <= 256 * 1024);
  assert.ok(nativeIdentityPreviewCounts(db).entries < 12);
  assert.equal(retain(db, 'giant', value('x'.repeat(300000))), false);
  assert.equal(retain(db, 'k'.repeat(256 * 1024)), false);
  assert.equal(readNativeIdentityPreview(db, 'giant'), undefined);
});
