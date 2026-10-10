import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { runExclusiveClinicalOperation } from '../clinical-operation.ts';
import { captureOwnershipReportOriginalProof } from '../ownership-report-plan.ts';
import { recordMutationStatement } from '../record-mutation-recipe.ts';
import { createRecordVersionWorkCounters, withRecordVersionWork } from '../record-version-work.ts';
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
import {
  completeVaultRecordTransactionPublication,
  type VaultRecordStagingWitness,
} from '../vault-store.ts';
import { recordPreparedPublicationFixture } from './helpers/record-prepared-publication-fixture.ts';

test('genuine vault prepared writes retain ordinary certificates without replaying accepted history', async (t) => {
  const f = await recordPreparedPublicationFixture(t);
  await runExclusiveClinicalOperation(f.db, async () => {
    const original = captureOwnershipReportOriginalProof(f.plan, f.db, f.profileId),
      originals = await captureRecordPublicationOriginals(f.db, f.profileId, original);
    try {
      let previousHead = f.beforeHead;
      for (let index = 0; index < 2; index++) {
        const name = `Fictional vault warm recipient ${index + 1}`,
          counters = createRecordVersionWorkCounters();
        let calls = 0;
        await withRecordVersionWork(counters, async () => {
          const preparation = await prepareRecordTransactionWithOriginals(
            f.db,
            () => {
              calls++;
              recordMutationStatement(f.db, 'UPDATE people SET display_name=? WHERE id=?').run(
                name,
                f.personId,
              );
              return { displayName: name };
            },
            { operationId: randomUUID(), fingerprint: `fictional-vault-warm-${index}` },
            originals,
          );
          try {
            await authenticateRecordTransactionPreparation(f.db, preparation);
            await stageRecordTransactionPreparation(f.db, preparation);
            assert.deepEqual(await commitRecordTransactionPreparation(f.db, preparation), {
              displayName: name,
            });
          } finally {
            discardRecordTransactionPreparation(f.db, preparation);
          }
        });
        assert.equal(calls, 1, 'final publication must not rerun business decisions');
        assert.equal(f.db.isTransaction, false);
        assert.equal(
          f.db.prepare('SELECT display_name FROM main.people WHERE id=?').get(f.personId)!
            .display_name,
          name,
        );
        const indexed = f.db
          .prepare(
            'SELECT v.contents_json FROM main.__record_current c JOIN main.__record_versions v ON v.version_id=c.version_id WHERE c.entity=? AND c.record_id=?',
          )
          .get('people', JSON.stringify([f.personId]));
        assert.equal(JSON.parse(String(indexed!.contents_json)).display_name, name);
        const head = Buffer.from(f.storage.read('head')!);
        assert.notDeepEqual(head, previousHead);
        previousHead = head;
        if (index === 0) assert.ok(counters.operation.vaultBackingColdDecodedVersions > 0);
        else {
          assert.equal(counters.operation.vaultBackingColdDecodedVersions, 0);
          assert.equal(counters.operation.vaultBackingReuses, 1);
        }
        assert.ok(counters.operation.vaultBackingChangedVersions > 0);
        t.diagnostic(JSON.stringify({ write: index + 1, vaultBacking: counters.operation }));
      }
    } finally {
      closeRecordPublicationOriginals(originals);
    }
  });
});

test('vault prepared completion refuses an unissued grant before observing derivative resources', async (t) => {
  const f = await recordPreparedPublicationFixture(t),
    plan = Object.freeze({}) as RecordTransactionBackingPlan,
    witness = Object.freeze({}) as VaultRecordStagingWitness;
  assert.throws(
    () => completeVaultRecordTransactionPublication(f.db, witness, plan),
    /foreign record accepted backing continuation/,
  );
  assert.deepEqual(f.storage.read('head'), f.beforeHead);
  assert.equal(f.db.isTransaction, false);
});
