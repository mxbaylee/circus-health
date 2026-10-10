import assert from 'node:assert/strict';
import test from 'node:test';
import { archiveRefusal, isArchiveRefusal } from '../archive-refusal.ts';

test('archive refusals preserve safe public guidance without trusting shaped errors', () => {
  const error = archiveRefusal('Fictional archive', 'This version cannot open it.');
  assert.equal(isArchiveRefusal(error), true);
  assert.equal(error.status, 409);
  assert.equal(error.code, 'ARCHIVE_UNSUPPORTED');
  assert.match(error.message, /Preserve this archive and use a compatible app release/);
  assert.equal(
    isArchiveRefusal(
      Object.assign(new Error('private content'), {
        status: 409,
        code: 'ARCHIVE_UNSUPPORTED',
      }),
    ),
    false,
  );
  assert.equal(isArchiveRefusal({ ...error }), false);
  assert.equal(isArchiveRefusal(null), false);
});
