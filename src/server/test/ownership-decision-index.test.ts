import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../database.ts';
import {
  prepareOwnershipDecisionIndex,
  ownershipDecisionQueries,
  ownershipDecisionIndexWork,
  ownershipExceptionIndexWork,
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
    assert.equal(selected.hasAssignmentPolicy(), false);
    const presencePlan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT 1 FROM __ownership_decision_index INDEXED BY __ownership_decision_index_source WHERE title IN ('Record ownership source','Report ownership default','Report ownership default hold') LIMIT 1",
      )
      .all();
    assert.ok(
      presencePlan.some((row) =>
        String(row.detail).includes(
          'SEARCH __ownership_decision_index USING COVERING INDEX __ownership_decision_index_source',
        ),
      ),
    );
    assert.ok(presencePlan.every((row) => !String(row.detail).startsWith('SCAN')));
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
    const routing = ownershipDecisionQueries(db)!;
    insert.run(
      'selected-plan',
      'Ownership correction group',
      '{"parentOperationId":"parent","groupId":"fictional"}',
    );
    insert.run(
      'selected-event',
      'Record ownership event',
      '{"operationId":"child","recordId":"fictional"}',
    );
    assert.deepEqual(
      Array.from(routing.receiptGroups('parent'), (row) => row.id),
      ['selected-plan'],
    );
    assert.deepEqual(
      Array.from(routing.receiptEvents('child'), (row) => row.id),
      ['selected-event'],
    );
    assert.equal(routing.hasReceiptEvents('child'), true);
    assert.equal(routing.hasReceiptEvents('unrelated'), false);
    for (const [field, title, scope, index] of [
      [
        'parent_operation_id',
        'Ownership correction group',
        'parent',
        '__ownership_decision_index_parent',
      ],
      ['operation_id', 'Record ownership event', 'child', '__ownership_decision_index_operation'],
    ]) {
      const query = db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT m.id,m.coverage_json FROM __ownership_decision_index i INDEXED BY ${index} JOIN main.manual_batches m ON m.id=i.id WHERE i.title=? AND i.${field}=? ORDER BY i.id`,
        )
        .all(title!, scope!);
      assert.ok(
        query.some((row) => String(row.detail).includes(`SEARCH i USING COVERING INDEX ${index}`)),
      );
      assert.ok(query.some((row) => /SEARCH m USING INDEX.*\(id=\?\)/.test(String(row.detail))));
      assert.ok(query.every((row) => !String(row.detail).startsWith('SCAN')));
    }
    db.exec('BEGIN');
    db.prepare(
      "UPDATE manual_batches SET coverage_json=json_set(coverage_json,'$.operationId','changed') WHERE id='selected-event'",
    ).run();
    assert.equal(routing.hasReceiptEvents('child'), false);
    assert.equal(routing.hasReceiptEvents('changed'), true);
    db.prepare("DELETE FROM manual_batches WHERE id='selected-plan'").run();
    assert.deepEqual([...routing.receiptGroups('parent')], []);
    db.exec('ROLLBACK');
    assert.equal(routing.hasReceiptEvents('child'), true);
    assert.equal(routing.hasReceiptEvents('changed'), false);
    assert.deepEqual(
      Array.from(routing.receiptGroups('parent'), (row) => row.id),
      ['selected-plan'],
    );
    db.exec('DROP TRIGGER temp.__ownership_decision_index_update');
    let waiterChecks = 0;
    const firstPreparation = prepareOwnershipDecisionIndex(db);
    await assert.rejects(
      prepareOwnershipDecisionIndex(db, {
        assertRunning() {
          throw Error('Fictional waiting caller cancelled');
        },
      }),
      /waiting caller cancelled/,
    );
    await Promise.all([
      firstPreparation,
      prepareOwnershipDecisionIndex(db, {
        assertRunning() {
          waiterChecks++;
        },
      }),
    ]);
    assert.equal(waiterChecks, 2);
    assert.equal(ownershipDecisionIndexWork(db).coldRows, 2055);
    assert.deepEqual(
      Array.from(ownershipDecisionQueries(db)!.receiptGroups('parent'), (row) => row.id),
      ['selected-plan'],
    );
  } finally {
    db.close();
  }
});

test('exception identity routing retains every record and invalidates on changes and index loss', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-exception-routing-'));
  const path = join(root, 'profile.sqlite');
  const db = openDatabase(path, 'fictional');
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const put = db.prepare(
    "INSERT INTO manual_batches(id,title,status,created_at,coverage_json) VALUES(?,'Import record exception','verified','2026-01-01',?)",
  );
  for (let index = 0; index < 97; index++)
    put.run(
      'unrelated-' + index,
      JSON.stringify({
        recordException: { identityKey: 'other-' + index, recordId: 'record-' + index },
      }),
    );
  put.run(
    'match-a',
    JSON.stringify({ recordException: { identityKey: 'selected', recordId: 'first' } }),
  );
  put.run(
    'match-b',
    JSON.stringify({ recordException: { identityKey: 'selected', recordId: 'second' } }),
  );
  await prepareOwnershipDecisionIndex(db);
  let selected = ownershipDecisionQueries(db)!;
  assert.deepEqual([...selected.exceptionRecordIds('selected')], ['first', 'second']);
  assert.deepEqual(ownershipExceptionIndexWork(db), { queries: 1, rows: 2 });
  db.exec('BEGIN');
  db.prepare(
    "UPDATE manual_batches SET coverage_json=json_set(coverage_json,'$.recordException.identityKey','other') WHERE id='match-a'",
  ).run();
  assert.deepEqual([...selected.exceptionRecordIds('selected')], ['second']);
  db.prepare("DELETE FROM manual_batches WHERE id='match-b'").run();
  assert.deepEqual([...selected.exceptionRecordIds('selected')], []);
  db.exec('ROLLBACK');
  assert.deepEqual([...selected.exceptionRecordIds('selected')], ['first', 'second']);
  put.run(
    'match-c',
    JSON.stringify({ recordException: { identityKey: 'selected', recordId: 'third' } }),
  );
  assert.deepEqual([...selected.exceptionRecordIds('selected')], ['first', 'second', 'third']);
  using peer = new DatabaseSync(path);
  peer.prepare("DELETE FROM manual_batches WHERE id='match-a'").run();
  assert.throws(() => [...selected.exceptionRecordIds('selected')], /Prepare complete accepted/);
  await prepareOwnershipDecisionIndex(db);
  selected = ownershipDecisionQueries(db)!;
  assert.deepEqual([...selected.exceptionRecordIds('selected')], ['second', 'third']);
  db.exec('DROP INDEX temp.__ownership_decision_index_exception_identity');
  assert.throws(() => [...selected.exceptionRecordIds('selected')], /Prepare complete accepted/);
  await prepareOwnershipDecisionIndex(db);
  assert.deepEqual(
    [...ownershipDecisionQueries(db)!.exceptionRecordIds('selected')],
    ['second', 'third'],
  );
});
