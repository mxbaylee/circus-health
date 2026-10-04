import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  prepareClinicalSourceFingerprintIndex,
  matchingClinicalSourceCanonicals,
} from '../intake-clinical-source-index.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import { canonicalLiteral, parseLiteralJSON } from '../intake-format.ts';
const canonical = (text: string) => canonicalLiteral(parseLiteralJSON(text));
function fixture(t: test.TestContext) {
  const db = new DatabaseSync(':memory:');
  db.exec(
    'CREATE TABLE source_records(id TEXT PRIMARY KEY,provider_id TEXT,kind TEXT,raw_json TEXT);',
  );
  t.after(() => db.close());
  return db;
}
test('canonical index warm lookup work is independent of provider history and preserves SQL LIKE/null semantics', async (t) => {
  for (const count of [8, 1024]) {
    const db = fixture(t),
      insert = db.prepare('INSERT INTO source_records VALUES(?,?,?,?)');
    for (let i = 0; i < count; i++)
      insert.run(
        'fictional-' + i,
        'clinic',
        'intake_record',
        JSON.stringify({ i, text: 'Fictional source ' + i }),
      );
    insert.run('case', 'clinic', 'INTAKEX', '{"b":2,"a":1}');
    insert.run('null', null, 'intake_record', '{"nullProvider":true}');
    insert.run('short', 'clinic', 'intake', '{"short":true}');
    await prepareClinicalSourceFingerprintIndex(db);
    const before = intakeWorkCounters(db),
      selected = [
        canonical('{"a":1,"b":2}'),
        canonical('{"short":true}'),
        canonical('{"absent":true}'),
      ];
    assert.deepEqual([...matchingClinicalSourceCanonicals(db, 'clinic', selected)], [selected[0]]);
    assert.equal(
      matchingClinicalSourceCanonicals(db, null, [canonical('{"nullProvider":true}')]).size,
      0,
    );
    await prepareClinicalSourceFingerprintIndex(db);
    const after = intakeWorkCounters(db);
    assert.equal(
      after.reconstruction.clinicalCanonicalIndexColdRows -
        before.reconstruction.clinicalCanonicalIndexColdRows,
      0,
    );
    assert.equal(
      after.warm.clinicalCanonicalIndexChangedBytes -
        before.warm.clinicalCanonicalIndexChangedBytes,
      0,
    );
    assert.equal(
      after.warm.clinicalCanonicalIndexLookups - before.warm.clinicalCanonicalIndexLookups,
      4,
    );
  }
});
test('canonical index follows speculative rollback and final changeset triggers without entering main capture', async (t) => {
  const db = fixture(t);
  await prepareClinicalSourceFingerprintIndex(db);
  const input = canonical('{"fictional":"pending"}'),
    session = db.createSession();
  db.exec('SAVEPOINT prepare');
  db.prepare('INSERT INTO source_records VALUES(?,?,?,?)').run(
    'one',
    'clinic',
    'intake_record',
    input,
  );
  assert.equal(matchingClinicalSourceCanonicals(db, 'clinic', [input]).size, 1);
  const changes = session.changeset();
  db.exec('ROLLBACK TO prepare');
  db.exec('RELEASE prepare');
  session.close();
  assert.equal(matchingClinicalSourceCanonicals(db, 'clinic', [input]).size, 0);
  const tables: string[] = [];
  assert.equal(
    db.applyChangeset(changes, {
      filter: (table) => {
        tables.push(table);
        return true;
      },
    }),
    true,
  );
  assert.deepEqual(tables, ['source_records']);
  assert.equal(matchingClinicalSourceCanonicals(db, 'clinic', [input]).size, 1);
  db.prepare('UPDATE source_records SET provider_id=?,raw_json=? WHERE id=?').run(
    'other',
    '{"fictional":"updated"}',
    'one',
  );
  assert.equal(matchingClinicalSourceCanonicals(db, 'clinic', [input]).size, 0);
  assert.equal(
    matchingClinicalSourceCanonicals(db, 'other', [canonical('{"fictional":"updated"}')]).size,
    1,
  );
  db.prepare('DELETE FROM source_records WHERE id=?').run('one');
  assert.equal(
    matchingClinicalSourceCanonicals(db, 'other', [canonical('{"fictional":"updated"}')]).size,
    0,
  );
});
test('lost trigger refuses stale lookup until explicit complete reconstruction', async (t) => {
  const db = fixture(t);
  await prepareClinicalSourceFingerprintIndex(db);
  db.exec('DROP TRIGGER temp.__clinical_source_fingerprints_insert');
  db.prepare('INSERT INTO source_records VALUES(?,?,?,?)').run(
    'one',
    'clinic',
    'intake_record',
    '{"fictional":1}',
  );
  assert.throws(
    () => matchingClinicalSourceCanonicals(db, 'clinic', [canonical('{"fictional":1}')]),
    /Prepare complete/,
  );
  await prepareClinicalSourceFingerprintIndex(db);
  assert.equal(
    matchingClinicalSourceCanonicals(db, 'clinic', [canonical('{"fictional":1}')]).size,
    1,
  );
});
