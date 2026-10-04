import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../database.ts';
import {
  prepareOwnershipDecisionIndex,
  ownershipDecisionQueries,
  ownershipDecisionIndexWork,
} from '../ownership-decision-index.ts';
import { latestOwnershipDecision } from '../ownership-journal.ts';
test('native ownership decision joins remain indexed across warm writes, rollback and disposable index loss', async () => {
  const db = openDatabase(':memory:', 'fictional');
  try {
    const insert = db.prepare(
      "INSERT INTO manual_batches(id,title,status,created_at,coverage_json) VALUES(?,?,'verified','2026-01-01',?)",
    );
    for (let i = 0; i < 2048; i++)
      insert.run(
        'unrelated-' + i,
        'Accepted clinical contribution',
        JSON.stringify({ sourceRecordId: 'unrelated-' + i, revision: i, padding: 'fictional' }),
      );
    insert.run(
      'selected-early',
      'Accepted clinical contribution',
      '{"sourceRecordId":"selected","revision":1,"mapping":{"kind":"document"}}',
    );
    insert.run(
      'selected-late',
      'Accepted clinical contribution',
      '{"sourceRecordId":"selected","revision":2,"mapping":{"kind":"observation"}}',
    );
    for (const [id, sequence] of [
      ['transition-a', 3],
      ['transition-z', 1],
    ] as const)
      insert.run(
        id,
        'Duplicate evidence decision',
        JSON.stringify({
          duplicateDecision: {
            sequence,
            occurrenceAttachment: { incomingSourceRecordId: 'selected' },
          },
        }),
      );
    let interrupted = false;
    await assert.rejects(
      prepareOwnershipDecisionIndex(db, {
        assertRunning() {
          interrupted = true;
          throw Error('Fictional stop');
        },
      }),
      /Fictional stop/,
    );
    assert.equal(interrupted, true);
    assert.throws(() => ownershipDecisionQueries(db), /Prepare complete accepted/);
    await prepareOwnershipDecisionIndex(db);
    const selected = ownershipDecisionQueries(db)!;
    assert.deepEqual(
      JSON.parse(String(selected.accepted('selected')!.coverage_json)),
      latestOwnershipDecision(db, 'Accepted clinical contribution', 'sourceRecordId', 'selected'),
    );
    assert.deepEqual(
      Array.from(selected.transitions('selected'), (row) => row.id),
      ['transition-z', 'transition-a'],
    );
    const work = ownershipDecisionIndexWork(db);
    assert.equal(work.coldRows, 2052);
    assert.equal(work.changedRows, 0);
    const sourcePlan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT id FROM __ownership_decision_index WHERE title='Accepted clinical contribution' AND source_record_id=? ORDER BY revision DESC,id DESC LIMIT 1",
      )
      .all('selected');
    assert.ok(
      sourcePlan.some((row) => String(row.detail).includes('__ownership_decision_index_source')),
    );
    db.exec('BEGIN');
    db.prepare(
      "UPDATE manual_batches SET coverage_json=json_set(coverage_json,'$.revision',3) WHERE id='selected-early'",
    ).run();
    assert.equal(JSON.parse(String(selected.accepted('selected')!.coverage_json)).revision, 3);
    assert.equal(ownershipDecisionIndexWork(db).changedRows, 1);
    db.exec('ROLLBACK');
    assert.equal(JSON.parse(String(selected.accepted('selected')!.coverage_json)).revision, 2);
    assert.equal(ownershipDecisionIndexWork(db).changedRows, 0);
    insert.run(
      'selected-new',
      'Accepted clinical contribution',
      '{"sourceRecordId":"selected","revision":4}',
    );
    await prepareOwnershipDecisionIndex(db);
    assert.deepEqual(ownershipDecisionIndexWork(db), { coldRows: 2052, changedRows: 1 });
    assert.equal(JSON.parse(String(selected.accepted('selected')!.coverage_json)).revision, 4);
    db.exec('DROP TRIGGER temp.__ownership_decision_index_update');
    assert.throws(() => selected.accepted('selected'), /Prepare complete accepted/);
    await prepareOwnershipDecisionIndex(db);
    assert.equal(ownershipDecisionIndexWork(db).coldRows, 2053);
    assert.equal(
      JSON.parse(String(ownershipDecisionQueries(db)!.accepted('selected')!.coverage_json))
        .revision,
      4,
    );
  } finally {
    db.close();
  }
});
