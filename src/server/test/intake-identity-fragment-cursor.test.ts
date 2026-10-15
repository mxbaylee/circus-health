import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  beginNativeIdentityPreview,
  clearNativeIdentityPreviews,
  sealNativeIdentityFragmentCursor,
  openNativeIdentityFragmentCursor,
} from '../intake-identity-preview-cache.ts';

test('identity fragment MAC binds exact position and owner selection and expires without fallback', () => {
  const db = new DatabaseSync(':memory:'),
    foreign = new DatabaseSync(':memory:');
  try {
    const epoch = beginNativeIdentityPreview(db),
      binding = 'a'.repeat(64),
      position = { offset: 32768, after: '0000000000000015', skip: 7 },
      cursor = sealNativeIdentityFragmentCursor(db, epoch, binding, position);
    assert.deepEqual(openNativeIdentityFragmentCursor(db, epoch, binding, cursor, 32768), position);
    assert.throws(
      () => openNativeIdentityFragmentCursor(db, epoch, 'b'.repeat(64), cursor, 32768),
      /Reload/,
    );
    assert.throws(
      () => openNativeIdentityFragmentCursor(db, epoch, binding, cursor, 32769),
      /Reload/,
    );
    assert.throws(
      () =>
        openNativeIdentityFragmentCursor(
          foreign,
          beginNativeIdentityPreview(foreign),
          binding,
          cursor,
          32768,
        ),
      /Reload/,
    );
    for (const changed of [
      '',
      'start',
      cursor + '.x',
      cursor.slice(0, -1) + (cursor.endsWith('0') ? '1' : '0'),
    ])
      assert.throws(
        () => openNativeIdentityFragmentCursor(db, epoch, binding, changed, 32768),
        /Reload/,
      );
    clearNativeIdentityPreviews(db);
    assert.throws(
      () => openNativeIdentityFragmentCursor(db, epoch, binding, cursor, 32768),
      /Reload/,
    );
    const current = beginNativeIdentityPreview(db);
    assert.throws(
      () => openNativeIdentityFragmentCursor(db, current, binding, cursor, 32768),
      /Reload/,
    );
    const next = sealNativeIdentityFragmentCursor(db, current, binding, position);
    assert.notEqual(next, cursor);
    assert.throws(
      () => openNativeIdentityFragmentCursor(db, current, binding, cursor, 32768),
      /Reload/,
    );
    assert.deepEqual(openNativeIdentityFragmentCursor(db, current, binding, next, 32768), position);
    db.exec('BEGIN');
    assert.throws(() => sealNativeIdentityFragmentCursor(db, current, binding, position), /Reload/);
    assert.throws(
      () => openNativeIdentityFragmentCursor(db, current, binding, next, 32768),
      /Reload/,
    );
    db.exec('ROLLBACK');
  } finally {
    db.close();
    foreign.close();
  }
});

test('closing the actual database expires the identity fragment transport key', () => {
  const db = new DatabaseSync(':memory:'),
    epoch = beginNativeIdentityPreview(db),
    binding = 'c'.repeat(64);
  const cursor = sealNativeIdentityFragmentCursor(db, epoch, binding, {
    offset: 32768,
    after: null,
    skip: 0,
  });
  db.close();
  assert.throws(
    () => openNativeIdentityFragmentCursor(db, epoch, binding, cursor, 32768),
    /Reload/,
  );
});
