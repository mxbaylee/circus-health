import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { openDatabase, transaction, HttpError } from '../database.ts';
import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';
import { appendOwnershipDecision } from '../ownership-journal.ts';
import { publishedOwnershipNameSupportPage } from '../ownership-name-support-page.ts';
import { rebuildRecordDatabase } from '../record-versions.ts';

test('accepted name support reference survives rebuild and refuses missing off-page evidence and another profile', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-accepted-name-support-'));
  const db = openDatabase(join(root, 'cache.sqlite'), 'fictional');
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const authority = memoryRecordAuthority(db),
    operationId = randomUUID(),
    effectKey = 'f'.repeat(64);
  const ids = ['support-one', 'support-two', 'support-three'];
  const digest = createHash('sha256').update(JSON.stringify(ids)).digest('hex');
  transaction(db, () => {
    for (const [ordinal, id] of ids.entries())
      appendOwnershipDecision(db, id, 'Ownership name support', {
        operationId: id,
        correctionOperationId: operationId,
        effectKey,
        supportOrdinal: ordinal,
        noteId: 'fictional-note',
        name: 'Fictional Name',
        sourceRecordId: 'record-' + ordinal,
        intakeId: 'original',
        groupId: 'group',
      });
    appendOwnershipDecision(
      db,
      'name-correction:' + operationId + ':destination:' + effectKey,
      'Remembered name correction',
      {
        noteId: 'fictional-note',
        name: 'Fictional Name',
        status: 'active',
        operationId,
        supportOperationsIncluded: false,
        supportOperationsReference: {
          operationId,
          effectKey,
          total: 3,
          digest,
          complete: true,
          url: 'fictional-reference',
        },
      },
    );
  });
  const first = publishedOwnershipNameSupportPage(db, 'fictional', operationId, effectKey, -1, 1);
  assert.equal(first.total, 3);
  assert.equal(first.complete, false);
  assert.equal(first.after, '0');
  assert.equal(first.items[0]!.operationId, ids[0]);
  assert.throws(
    () => publishedOwnershipNameSupportPage(db, 'another', operationId, effectKey),
    (e) => e instanceof HttpError && e.status === 403,
  );
  assert.throws(
    () =>
      transaction(db, () => {
        db.prepare('DELETE FROM manual_batches WHERE id=?').run(ids[2]);
        try {
          publishedOwnershipNameSupportPage(db, 'fictional', operationId, effectKey, -1, 1);
        } catch {
          /* Caught incompleteness still rejects the owned transaction. */
        }
      }),
    /incomplete/,
  );
  assert.equal(
    publishedOwnershipNameSupportPage(db, 'fictional', operationId, effectKey, -1, 1).total,
    3,
  );
  const rebuilt = join(root, 'recovered.sqlite');
  rebuildRecordDatabase(rebuilt, { profileId: 'fictional', storage: authority.storage });
  const recovered = openDatabase(rebuilt, 'fictional');
  try {
    authority.attach(recovered);
    assert.deepEqual(
      publishedOwnershipNameSupportPage(recovered, 'fictional', operationId, effectKey, -1, 1),
      first,
    );
    assert.equal(
      publishedOwnershipNameSupportPage(recovered, 'fictional', operationId, effectKey, 1, 1)
        .items[0]!.operationId,
      ids[2],
    );
  } finally {
    recovered.close();
  }
});
