import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { prepareReportSourceRouting } from '../intake-report-source-routing.ts';
import { clearIntakeCollectionCache } from '../intake-state-collections.ts';

test('source routing keeps private bounded certificates across only known own writes', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  let builds = 0;
  const input = {
    sourceId: 'fictional-a',
    binding: 'complete-root-a',
    assertCurrent() {},
    *rows() {
      builds++;
      yield {
        kind: 'owner' as const,
        candidate: 'candidate',
        version: 'version',
        groupId: 'correct',
        basis: 1,
      };
      yield { kind: 'draft' as const, identity: 'exact-occurrence', disposition: 'review_later' };
    },
  };
  const read = () => prepareReportSourceRouting(db, input);
  assert.equal((await read()).owner('candidate', 'version'), 'correct');
  await prepareReportSourceRouting(db, { ...input, sourceId: 'fictional-b' });
  assert.equal((await read()).disposition('exact-occurrence'), 'review_later');
  assert.equal(builds, 2, 'known writes preparing another source preserve the first proof');
  db.exec(
    "UPDATE __report_source_routing_owners SET groupId='wrong'; UPDATE __report_source_routing SET ready=1",
  );
  assert.equal((await read()).owner('candidate', 'version'), 'correct');
  assert.equal(builds, 3, 'a restored SQL readiness flag cannot restore a private proof');
  db.exec("BEGIN; UPDATE __report_source_routing_owners SET groupId='wrong'");
  await assert.rejects(read, /outside-transaction/);
  db.exec('ROLLBACK');
  assert.equal((await read()).owner('candidate', 'version'), 'correct');
  assert.equal(builds, 4, 'rolled-back writes still invalidate the old proof');
  clearIntakeCollectionCache(db);
  assert.equal((await read()).owner('candidate', 'version'), 'correct');
  assert.equal(builds, 5, 'registry identity is checked independently of serialized stamp values');
  db.exec(
    "CREATE TEMP TRIGGER unrelated_name AFTER INSERT ON __report_source_routing_owners BEGIN UPDATE __report_source_routing_owners SET groupId='wrong'; END",
  );
  assert.equal((await read()).owner('candidate', 'version'), 'correct');
  assert.equal(builds, 6, 'an unexpected attached trigger is removed before rebuilding');
  assert.equal(
    db.prepare("SELECT name FROM sqlite_temp_schema WHERE name='unrelated_name'").get(),
    undefined,
  );
  for (let index = 0; index < 33; index++)
    await prepareReportSourceRouting(db, { ...input, sourceId: 'bounded-proof-' + index });
  assert.equal((await read()).owner('candidate', 'version'), 'correct');
  assert.equal(builds, 40, 'the private 32-source proof window evicts and safely rebuilds');
});

test('source routing rejects interleaved cache mutation rather than certifying partial preparation', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const input = {
    sourceId: 'fictional',
    binding: 'complete-root',
    assertCurrent() {},
    *rows() {
      for (let index = 0; index < 65; index++)
        yield {
          kind: 'owner' as const,
          candidate: 'candidate-' + index,
          version: 'version',
          groupId: 'correct',
          basis: 1,
        };
    },
  };
  const pending = prepareReportSourceRouting(db, input);
  db.exec(
    "UPDATE __report_source_routing_owners SET groupId='wrong'; UPDATE __report_source_routing SET ready=1",
  );
  await assert.rejects(() => pending, /Refresh this complete/);
  const recovered = await prepareReportSourceRouting(db, input);
  assert.equal(recovered.owner('candidate-0', 'version'), 'correct');
  assert.equal(recovered.owner('candidate-64', 'version'), 'correct');
});
