import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { runExclusiveClinicalOperation } from '../clinical-operation.ts';
import {
  clinicalReviewRevision,
  observeTransactionOutcome,
  type TransactionOutcome,
} from '../database.ts';
import { createIntakeStateStorage } from '../intake-state-storage.ts';
import { captureOwnershipReportOriginalProof } from '../ownership-report-plan.ts';
import {
  createOwnershipSourceSnapshotPreparation,
  readOwnershipSourceSnapshot,
} from '../ownership-source-snapshots.ts';
import {
  captureRecordPublicationOriginals,
  closeRecordPublicationOriginals,
  type RecordPublicationOriginals,
} from '../record-versions.ts';
import { recordPreparedPublicationFixture } from './helpers/record-prepared-publication-fixture.ts';

for (const backend of ['vault', 'contributor'] as const) {
  test(`${backend} ownership snapshot checkpoints and final adoption keep the same original parent`, async (t) => {
    const f = await recordPreparedPublicationFixture(t, undefined, backend),
      outcomes: TransactionOutcome[] = [],
      stop = observeTransactionOutcome(f.db, (outcome) => outcomes.push(outcome));
    t.after(stop);
    await runExclusiveClinicalOperation(f.db, async () => {
      const original = captureOwnershipReportOriginalProof(f.plan, f.db, f.profileId),
        originals = await captureRecordPublicationOriginals(f.db, f.profileId, original),
        clinical = clinicalReviewRevision(f.db),
        beforeHead = Buffer.from(f.storage.read('head')!);
      try {
        const factory = createOwnershipSourceSnapshotPreparation(f.db, f.source, {
            originalRecordPublicationOriginals: originals,
          }),
          reference = await factory.prepareMembership({
            sourceRecordIds: () => ['fictional-member-a', 'fictional-member-b'],
          });
        const checkpoints = outcomes.filter((outcome) => outcome.committed);
        assert.ok(checkpoints.length > 1, 'actual preparation publishes multiple prerequisites');
        assert.ok(checkpoints.every((outcome) => outcome.succeeded && outcome.intakeMaintenance));
        await factory.finishMaintenance();
        assert.equal(
          outcomes.filter((outcome) => outcome.committed).length,
          checkpoints.length + 1,
        );
        factory.assertPublishedCurrent(reference);
        assert.deepEqual(readOwnershipSourceSnapshot(f.db, reference).sourceRecordIds, [
          'fictional-member-a',
          'fictional-member-b',
        ]);
        assert.equal(clinicalReviewRevision(f.db), clinical);
        assert.notDeepEqual(f.storage.read('head'), beforeHead);
        assert.equal(outcomes.length % 2, 0);
        for (let index = 0; index < outcomes.length; index += 2) {
          const tentative = outcomes[index]!,
            accepted = outcomes[index + 1]!;
          assert.equal(tentative.prepared, true);
          assert.equal(tentative.committed, false);
          assert.equal(tentative.intakeMaintenance, undefined);
          assert.equal(accepted.committed, true);
          assert.equal(accepted.succeeded, true);
          assert.equal(accepted.intakeMaintenance, true);
          assert.notEqual(accepted.token, tentative.token);
        }
      } finally {
        closeRecordPublicationOriginals(originals);
      }
    });
  });
}

test('collection original-backed entry rejects an unissued original handle before consuming its preparation', async (t) => {
  const f = await recordPreparedPublicationFixture(t);
  await runExclusiveClinicalOperation(f.db, async () => {
    const original = captureOwnershipReportOriginalProof(f.plan, f.db, f.profileId),
      originals = await captureRecordPublicationOriginals(f.db, f.profileId, original),
      identity = {
        profileId: f.profileId,
        intakeId: f.source.id,
        sourceHash: String(
          f.db.prepare('SELECT sha256 FROM source_files WHERE id=?').get(f.source.id)!.sha256,
        ),
      },
      collections = createIntakeStateStorage(f.db, identity).collections,
      view = collections.openView(),
      operationId = randomUUID(),
      prepared = collections.prepare(view, {
        operationId,
        requestDigest: createHash('sha256').update(operationId).digest('hex'),
        domainVersion: collections.binding(view)!.logical.domainVersion,
        changes: [
          {
            area: 'builds',
            collection: 'fictional-original-backed',
            op: 'append',
            value: 'Fictional entry',
          },
        ],
      }),
      description = collections.inspectPrepared(prepared),
      beforeHead = Buffer.from(f.storage.read('head')!),
      clinical = clinicalReviewRevision(f.db);
    try {
      await assert.rejects(
        collections.commitMaintenanceWithOriginalsAsync(
          prepared,
          Object.freeze({}) as RecordPublicationOriginals,
        ),
        /original backing unavailable/,
      );
      assert.deepEqual(f.storage.read('head'), beforeHead);
      assert.deepEqual(collections.inspectPrepared(prepared).result, description.result);
      assert.deepEqual(
        await collections.commitMaintenanceWithOriginalsAsync(prepared, originals),
        description.result,
      );
      assert.equal(clinicalReviewRevision(f.db), clinical);
      assert.notDeepEqual(f.storage.read('head'), beforeHead);
    } finally {
      collections.disposePreparation(prepared);
      closeRecordPublicationOriginals(originals);
    }
  });
});
