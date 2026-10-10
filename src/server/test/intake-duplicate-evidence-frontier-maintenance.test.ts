import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { constants } from 'node:sqlite';
import { openDatabase, transaction } from '../database.ts';
import {
  duplicateEvidenceIndexWork,
  prepareDuplicateEvidenceIndex,
} from '../duplicate-evidence-index.ts';
import {
  captureIntakeFrontierAttempts,
  ensureIntakeFrontierObserver,
  intakeFrontierAttemptCounts,
  readIntakeFrontierAttempts,
} from '../intake-lookup-frontier-observer.ts';
import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';

async function fixture(t: TestContext) {
  const db = openDatabase(':memory:', 'fictional-duplicate-frontier');
  t.after(() => db.close());
  memoryRecordAuthority(db);
  transaction(db, () => {
    db.prepare('INSERT INTO source_files(id,path,sha256,bytes) VALUES(?,?,?,?)').run(
      'fictional-original',
      'fictional-original.txt',
      '1'.repeat(64),
      1,
    );
    db.prepare(
      'INSERT INTO source_records(id,source_file_id,source_key,raw_json) VALUES(?,?,?,?)',
    ).run('fictional-source', 'fictional-original', 'fictional-source', '{}');
    db.prepare('INSERT INTO documents(id,source_record_id,title) VALUES(?,?,?)').run(
      'fictional-saved',
      'fictional-source',
      'Independently fictional saved document',
    );
    db.prepare(
      'INSERT INTO evidence(id,entity_type,entity_id,source_record_id) VALUES(?,?,?,?)',
    ).run('fictional-evidence', 'document', 'fictional-saved', 'fictional-source');
  });
  await prepareDuplicateEvidenceIndex(db);
  db.exec('CREATE TEMP TABLE fictional_foreign(value INTEGER)');
  ensureIntakeFrontierObserver(db);
  transaction(db, () => {
    db.prepare('UPDATE evidence SET locator_json=? WHERE id=?').run(
      JSON.stringify({ page: 'fictional-updated-page' }),
      'fictional-evidence',
    );
  });
  const captured = captureIntakeFrontierAttempts(db);
  assert.ok(captured, 'the accepted outcome has an idle original frontier');
  return { db, captured };
}

test('warm duplicate evidence maintenance preserves the frontier captured after accepted evidence', async (t) => {
  const { db, captured } = await fixture(t),
    before = duplicateEvidenceIndexWork(db),
    total = db.prepare('SELECT CAST(total_changes() AS TEXT) AS n'),
    writesBefore = BigInt(String(total.get()!.n));
  await prepareDuplicateEvidenceIndex(db);
  const after = duplicateEvidenceIndexWork(db),
    interval = readIntakeFrontierAttempts(db, captured);
  t.diagnostic(
    JSON.stringify({
      maintenanceWrites: String(BigInt(String(total.get()!.n)) - writesBefore),
      hashedRows: after.rows - before.rows,
      originalFrontierRetained: interval !== undefined,
      observer: intakeFrontierAttemptCounts(db),
    }),
  );
  assert.equal(after.rows - before.rows, 1);
  assert.ok(interval, 'fixed duplicate-cache writes must preserve the original frontier');
  assert.deepEqual(interval, {
    attempts: 0,
    ownedWrites: 0,
    headSourceIds: [],
    ordinaryTokens: [],
  });
});

for (const mutation of [
  'before TEMP ABA',
  'during TEMP ABA',
  'during ordinary acceptance',
] as const)
  test(`warm duplicate evidence maintenance cannot forgive ${mutation}`, async (t) => {
    const { db, captured } = await fixture(t);
    let injected = false;
    const inject = () => {
      if (injected) return;
      injected = true;
      if (mutation === 'during ordinary acceptance')
        transaction(db, () => {
          db.prepare('UPDATE documents SET title=? WHERE id=?').run(
            'Independently fictional changed title',
            'fictional-saved',
          );
        });
      else db.exec('INSERT INTO fictional_foreign VALUES(1); DELETE FROM fictional_foreign');
    };
    if (mutation === 'before TEMP ABA') inject();
    await prepareDuplicateEvidenceIndex(db, {
      assertRunning: mutation === 'before TEMP ABA' ? undefined : inject,
    });
    assert.equal(injected, true);
    assert.equal(readIntakeFrontierAttempts(db, captured), undefined);
  });

test('warm duplicate evidence maintenance cannot forgive source ABA in a caller assertion', async (t) => {
  const { db, captured } = await fixture(t);
  let injected = false;
  await assert.rejects(
    prepareDuplicateEvidenceIndex(db, {
      assertRunning() {
        if (injected) return;
        injected = true;
        db.prepare('UPDATE source_files SET sha256=? WHERE id=?').run(
          '2'.repeat(64),
          'fictional-original',
        );
        db.prepare('UPDATE source_files SET sha256=? WHERE id=?').run(
          '1'.repeat(64),
          'fictional-original',
        );
      },
    }),
    { code: 'DUPLICATE_EVIDENCE_PENDING' },
  );
  assert.equal(injected, true);
  assert.equal(readIntakeFrontierAttempts(db, captured), undefined);
});

test('warm duplicate evidence maintenance preserves SQL policy denial of its fixed cache writes', async (t) => {
  const { db } = await fixture(t);
  db.setAuthorizer((action, name) =>
    action === constants.SQLITE_UPDATE && name === '__duplicate_evidence_cache'
      ? constants.SQLITE_DENY
      : constants.SQLITE_OK,
  );
  ensureIntakeFrontierObserver(db);
  const captured = captureIntakeFrontierAttempts(db);
  assert.ok(captured);
  await assert.rejects(prepareDuplicateEvidenceIndex(db), /not authorized/i);
  assert.equal(readIntakeFrontierAttempts(db, captured), undefined);
  assert.equal(
    db
      .prepare('SELECT dirty FROM __duplicate_evidence_cache WHERE kind=? AND id=?')
      .get('document', 'fictional-saved')!.dirty,
    1,
  );
});
