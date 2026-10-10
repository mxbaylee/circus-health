import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { runExclusiveClinicalOperation } from '../clinical-operation.ts';
import {
  packageSessionAssertionPrerequisites,
  packageSessionOriginalPhysicalSource,
  withPackageSessionSource,
} from '../intake-package-session.ts';
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
} from '../record-versions.ts';
import { recordPreparedPublicationFixture } from './helpers/record-prepared-publication-fixture.ts';

test('actual vault prepared publication completes inside a genuine original source lease', async (t) => {
  const f = await recordPreparedPublicationFixture(t);
  let assertion: (() => void) | undefined;
  const result = await runExclusiveClinicalOperation(f.db, async (operation) =>
    withPackageSessionSource(
      { db: f.db, root: f.root, profileId: f.profileId, id: f.source.id },
      async (lease) => {
        assertion = lease.assertPublicationCurrent;
        assert.deepEqual(packageSessionAssertionPrerequisites(assertion, f.db), []);
        const originalSource = packageSessionOriginalPhysicalSource(assertion, f.db);
        assert.ok(originalSource);
        assert.equal(originalSource.sourceFd, lease.sourceFd);
        assert.equal(originalSource.acceptedPath, f.sourcePath);
        assert.equal(originalSource.binding.intakeId, f.source.id);
        lease.assertCurrent();
        return runExclusiveClinicalOperation(
          f.db,
          async () => {
            const original = captureOwnershipReportOriginalProof(f.plan, f.db, f.profileId),
              originals = await captureRecordPublicationOriginals(f.db, f.profileId, original);
            try {
              const preparation = await prepareRecordTransactionWithOriginals(
                f.db,
                () => {
                  recordMutationStatement(f.db, 'UPDATE people SET display_name=? WHERE id=?').run(
                    'Fictional leased recipient',
                    f.personId,
                  );
                  return { changed: true };
                },
                { operationId: randomUUID(), fingerprint: 'fictional-leased-publication' },
                originals,
              );
              try {
                await authenticateRecordTransactionPreparation(f.db, preparation);
                await stageRecordTransactionPreparation(f.db, preparation);
                assert.deepEqual(f.storage.read('head'), f.beforeHead);
                assert.deepEqual(
                  { ...f.db.prepare('SELECT * FROM people WHERE id=?').get(f.personId)! },
                  f.beforePerson,
                );
                t.diagnostic('phase: normal original lease and combined final publication');
                return await commitRecordTransactionPreparation<{ changed: boolean }>(
                  f.db,
                  preparation,
                );
              } finally {
                discardRecordTransactionPreparation(f.db, preparation);
              }
            } finally {
              closeRecordPublicationOriginals(originals);
            }
          },
          { operation, assertRunning: lease.assertPublicationCurrent },
        );
      },
    ),
  );
  assert.deepEqual(result, { changed: true });
  assert.ok(assertion);
  assert.equal(packageSessionOriginalPhysicalSource(assertion, f.db), undefined);
  assert.equal(f.db.isTransaction, false);
  assert.notDeepEqual(f.storage.read('head'), f.beforeHead);
  assert.equal(
    f.db.prepare('SELECT display_name FROM main.people WHERE id=?').get(f.personId)!.display_name,
    'Fictional leased recipient',
  );
  const indexed = f.db
    .prepare(
      'SELECT v.contents_json FROM main.__record_current c JOIN main.__record_versions v ON v.version_id=c.version_id WHERE c.entity=? AND c.record_id=?',
    )
    .get('people', JSON.stringify([f.personId]));
  assert.equal(
    JSON.parse(String(indexed!.contents_json)).display_name,
    'Fictional leased recipient',
  );
});
