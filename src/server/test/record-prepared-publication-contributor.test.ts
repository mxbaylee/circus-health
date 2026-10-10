import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { runExclusiveClinicalOperation } from '../clinical-operation.ts';
import { observeTransactionOutcome } from '../database.ts';
import {
  completeContributorRecordStagingPublication,
  type ContributorRecordStagingWitness,
} from '../contributor-record-staging.ts';
import { captureOwnershipReportOriginalProof } from '../ownership-report-plan.ts';
import { recordMutationStatement } from '../record-mutation-recipe.ts';
import {
  authenticateRecordTransactionPreparation,
  captureRecordPublicationOriginals,
  closeRecordPublicationOriginals,
  commitRecordTransactionPreparation,
  discardRecordTransactionPreparation,
  prepareRecordTransactionWithOriginals,
  stageRecordTransactionPreparation,
  type RecordTransactionBackingPlan,
} from '../record-versions.ts';
import { recordPreparedPublicationFixture } from './helpers/record-prepared-publication-fixture.ts';

test('genuine contributor storage close notification preserves the committed prepared receipt', async (t) => {
  const f = await recordPreparedPublicationFixture(t, undefined, 'contributor');
  assert.throws(
    () =>
      completeContributorRecordStagingPublication(
        f.db,
        Object.freeze({}) as ContributorRecordStagingWitness,
        Object.freeze({}) as RecordTransactionBackingPlan,
      ),
    /foreign record accepted backing continuation/,
  );
  assert.deepEqual(f.storage.read('head'), f.beforeHead);
  let closed = false;
  const stop = observeTransactionOutcome(f.db, (outcome) => {
    if (outcome.committed && outcome.succeeded) {
      closed = true;
      f.closeStorage();
    }
  });
  t.after(stop);
  await runExclusiveClinicalOperation(f.db, async () => {
    const original = captureOwnershipReportOriginalProof(f.plan, f.db, f.profileId),
      originals = await captureRecordPublicationOriginals(f.db, f.profileId, original);
    try {
      const preparation = await prepareRecordTransactionWithOriginals(
        f.db,
        () => {
          recordMutationStatement(f.db, 'UPDATE people SET display_name=? WHERE id=?').run(
            'Fictional closed-storage recipient',
            f.personId,
          );
          return { changed: true };
        },
        { operationId: randomUUID(), fingerprint: 'fictional-contributor-close' },
        originals,
      );
      try {
        await authenticateRecordTransactionPreparation(f.db, preparation);
        await stageRecordTransactionPreparation(f.db, preparation);
        assert.deepEqual(await commitRecordTransactionPreparation(f.db, preparation), {
          changed: true,
        });
        assert.equal(closed, true);
        assert.equal(f.db.isTransaction, false);
        const accepted = readFileSync(join(f.paths.records, 'head'));
        assert.notDeepEqual(accepted, f.beforeHead);
        assert.equal(
          f.db.prepare('SELECT display_name FROM main.people WHERE id=?').get(f.personId)!
            .display_name,
          'Fictional closed-storage recipient',
        );
        const indexed = f.db
          .prepare(
            'SELECT v.contents_json FROM main.__record_current c JOIN main.__record_versions v ON v.version_id=c.version_id WHERE c.entity=? AND c.record_id=?',
          )
          .get('people', JSON.stringify([f.personId]));
        assert.equal(
          JSON.parse(String(indexed!.contents_json)).display_name,
          'Fictional closed-storage recipient',
        );
        await assert.rejects(commitRecordTransactionPreparation(f.db, preparation), {
          message: 'Record replay requires its genuine released preparation',
        });
        assert.deepEqual(readFileSync(join(f.paths.records, 'head')), accepted);
      } finally {
        discardRecordTransactionPreparation(f.db, preparation);
      }
    } finally {
      closeRecordPublicationOriginals(originals);
    }
  });
});
